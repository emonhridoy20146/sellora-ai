import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Redis } from 'ioredis';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { canonicalJson, sha256 } from '../../common/crypto/tokens.js';
import { AppError, type FieldError } from '../../common/errors/app-error.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { CartsService } from '../carts/carts.service.js';
import { CustomersService } from '../commerce/customers.service.js';
import { OrdersService, type OrderDoc } from '../commerce/orders.service.js';
import {
  CategoryRepository,
  OrderRepository,
  ProductRepository,
} from '../commerce/repositories.js';
import type { Category, OrderAttribution, Product } from '../commerce/schemas.js';
import { ShopSettingsService } from '../commerce/shop-settings.service.js';
import { escapeRegex } from '../commerce/text.js';
import { CourierAccountsService } from '../couriers/courier-accounts.service.js';
import type { CourierKey } from '../couriers/courier.types.js';
import { OrgsService, type OrganizationDoc } from '../orgs/orgs.service.js';
import type { ShopGatewayKey } from '../commerce/schemas.js';
import {
  ShopPaymentsService,
  type PaymentChoice,
  type PaymentStart,
} from '../shop-payments/shop-payments.service.js';
import type { Store, StorePageKey } from './schemas.js';
import { runIdempotent } from './idempotency.js';
import { StoreDomainsService } from './store-domains.service.js';
import { parseStoreHost } from './store-hosts.js';
import { StoreLinksService } from './store-links.service.js';
import { StoreStatsService } from './store-stats.service.js';
import type { StoreSection } from './themes.js';

type StoreDoc = WithId<Store>;
type ProductDoc = WithId<Product>;
type CategoryDoc = WithId<Category>;

/**
 * What a shopper sees at a store's address. `open` and `preview` show the shop; the rest
 * show a holding page: `coming_soon` (being set up or waiting for review), `paused` (closed
 * by the business for a while), `unavailable` (closed by Sellora, or the plan has lapsed).
 */
export type StoreState = 'open' | 'preview' | 'coming_soon' | 'paused' | 'unavailable';

export interface ResolvedStore {
  store: StoreDoc;
  org: OrganizationDoc;
  state: StoreState;
}

export interface CartLineInput {
  productId: string;
  variantId: string;
  quantity: number;
}

export interface CheckoutInput {
  items: CartLineInput[];
  customer: { name: string; phone: string; email?: string };
  address: { line1: string; area?: string; city?: string; district?: string };
  zoneId: string | null;
  note?: string;
  website?: string;
  /** The saved cart this checkout came from (ADR 0018), closed when the order is made. */
  cartToken?: string;
  /** Where the shopper came from (ADR 0027), kept on the order. */
  attribution?: OrderAttribution;
  /** Cash on delivery (the default) or online, and the gateway (ADR 0029). */
  payment?: PaymentChoice;
}

/** Products shown per home page section, at most. */
const SECTION_LIMIT_MAX = 12;
/** "Only N left" is shown at or below this stock. */
const LOW_STOCK_SHOWN = 5;
const SITEMAP_MAX = 5000;

const PAGE_KEYS: StorePageKey[] = ['about', 'shipping', 'returns', 'privacy', 'terms'];

function maskPhone(phone: string | undefined): string | null {
  if (!phone) return null;
  return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

/**
 * Everything a shopper does in an online store: browse, price a cart, place an order,
 * see the receipt and track it. Called only by the storefront app (server to server, with
 * the storefront key). Each call finds the store by the Host the shopper used, then reads
 * that one business's data inside its tenant scope.
 */
@Injectable()
export class StorefrontService {
  private readonly logger = new Logger(StorefrontService.name);

  constructor(
    @InjectModel('Store') private readonly storeModel: Model<Store>,
    private readonly orgs: OrgsService,
    private readonly entitlements: EntitlementsService,
    private readonly links: StoreLinksService,
    private readonly domains: StoreDomainsService,
    private readonly products: ProductRepository,
    private readonly categories: CategoryRepository,
    private readonly orderRepo: OrderRepository,
    private readonly orders: OrdersService,
    private readonly customers: CustomersService,
    private readonly shopSettings: ShopSettingsService,
    private readonly couriers: CourierAccountsService,
    private readonly limits: RateLimitService,
    private readonly carts: CartsService,
    private readonly stats: StoreStatsService,
    private readonly shopPayments: ShopPaymentsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ---------------------------------------------------------------- finding the store

  /** The store at `host`, and what shoppers may see of it; null when there is none. */
  async resolve(host: string, previewToken?: string): Promise<ResolvedStore | null> {
    const parsed = parseStoreHost(host, this.links.baseDomain());
    if (!parsed) return null;
    let filter: Record<string, unknown>;
    if (parsed.kind === 'handle') filter = { handle: parsed.handle };
    else {
      const storeId = await this.domains.activeStoreId(parsed.host);
      if (!storeId) return null;
      filter = { _id: storeId };
    }
    const store = await this.storeModel
      .findOne(filter)
      .setOptions({ [CROSS_TENANT]: true })
      .lean<StoreDoc>()
      .exec();
    if (!store) return null;
    const org = await this.orgs.get(store.orgId.toHexString());
    return { store, org, state: await this.stateOf(store, org, previewToken) };
  }

  private async stateOf(
    store: StoreDoc,
    org: OrganizationDoc,
    previewToken?: string,
  ): Promise<StoreState> {
    if (org.status !== 'active') return 'unavailable';
    if (org.isDemo && org.demoExpiresAt && org.demoExpiresAt <= new Date()) return 'unavailable';
    if (store.status === 'suspended') return 'unavailable';
    if (!(await this.entitlements.hasModule(org._id.toHexString(), 'storefront')))
      return 'unavailable';
    if (this.links.verifyPreview(previewToken) === store._id.toHexString()) return 'preview';
    if (store.status === 'live') return 'open';
    if (store.status === 'paused') return 'paused';
    return 'coming_soon';
  }

  /** The store a shop request is for, or 404 when it is not open (and not previewed). */
  async requireOpen(host: string, previewToken?: string): Promise<ResolvedStore> {
    const resolved = await this.resolve(host, previewToken);
    if (!resolved || (resolved.state !== 'open' && resolved.state !== 'preview'))
      throw AppError.notFound('store', 'This store is not open.');
    return resolved;
  }

  /** Runs `fn` in the store's business, as a shopper. */
  inStore<T>(r: ResolvedStore, fn: () => Promise<T>): Promise<T> {
    return RequestContext.withTenant(r.org._id.toHexString(), fn, {
      type: 'visitor',
      id: `store:${r.store._id.toHexString()}`,
    });
  }

  // ---------------------------------------------------------------- shopper-facing shapes

  /** The store as the storefront renders it. Closed stores show only what a holding page needs. */
  publicStore(r: ResolvedStore) {
    const { store, org, state } = r;
    const base = {
      id: store._id.toHexString(),
      name: store.name,
      handle: store.handle,
      url: this.links.url(store),
      language: store.language,
      state,
    };
    if (state === 'unavailable') return { ...base, theme: null };
    const brand = {
      ...base,
      themeKey: store.themeKey,
      currency: org.currency,
      contact: {
        phone: store.contact.phone ?? null,
        whatsapp: store.contact.whatsapp ?? null,
        email: store.contact.email ?? null,
        address: store.contact.address ?? null,
      },
      social: {
        facebook: store.social.facebook ?? null,
        instagram: store.social.instagram ?? null,
        youtube: store.social.youtube ?? null,
        tiktok: store.social.tiktok ?? null,
      },
    };
    if (state !== 'open' && state !== 'preview')
      return {
        ...brand,
        theme: { ...store.theme, sections: [] as StoreSection[], announcement: '' },
      };
    return {
      ...brand,
      theme: { ...store.theme, sections: store.theme.sections.filter((s) => s.enabled) },
      seo: { title: store.seo.title || store.name, description: store.seo.description ?? '' },
      pages: PAGE_KEYS.filter((k) => Boolean(store.pages[k]?.trim())),
      checkout: { note: store.checkout.note ?? '', minOrderMinor: store.checkout.minOrderMinor },
    };
  }

  private card(p: ProductDoc) {
    const cheapest = p.variants.reduce(
      (a, v) => (v.priceMinor < a.priceMinor ? v : a),
      p.variants[0]!,
    );
    const prices = p.variants.map((v) => v.priceMinor);
    return {
      id: p._id.toHexString(),
      slug: p.slug,
      name: p.name,
      image: p.images[0] ? { url: p.images[0].url, alt: p.images[0].alt ?? p.name } : null,
      priceMinor: cheapest.priceMinor,
      compareAtPriceMinor: cheapest.compareAtPriceMinor ?? null,
      priceVaries: Math.min(...prices) !== Math.max(...prices),
      inStock: p.variants.some((v) => !v.trackStock || v.stock > 0),
    };
  }

  private detail(p: ProductDoc, category: CategoryDoc | null) {
    return {
      ...this.card(p),
      description: p.description,
      images: p.images.map((i) => ({ url: i.url, alt: i.alt ?? p.name })),
      options: p.options,
      variants: p.variants.map((v) => ({
        id: v._id.toHexString(),
        title: v.title,
        optionValues: v.optionValues,
        priceMinor: v.priceMinor,
        compareAtPriceMinor: v.compareAtPriceMinor ?? null,
        available: !v.trackStock || v.stock > 0,
        left: v.trackStock && v.stock > 0 && v.stock <= LOW_STOCK_SHOWN ? v.stock : null,
      })),
      category: category ? { name: category.name, slug: category.slug } : null,
      currency: p.currency,
    };
  }

  // ---------------------------------------------------------------- catalog

  /** Categories that have active products, with how many. */
  async categoryList() {
    const [cats, counts] = await Promise.all([
      this.categories.find({}, { sort: { sortOrder: 1, name: 1 } }),
      this.products.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { status: 'active', categoryId: { $exists: true } } },
        { $group: { _id: '$categoryId', n: { $sum: 1 } } },
      ]),
    ]);
    const byId = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
    return cats
      .filter((c) => (byId.get(c._id.toHexString()) ?? 0) > 0)
      .map((c) => ({
        id: c._id.toHexString(),
        name: c.name,
        slug: c.slug,
        productCount: byId.get(c._id.toHexString())!,
      }));
  }

  private sortFor(sort: 'newest' | 'popular' | 'price_asc' | 'price_desc'): Record<string, 1 | -1> {
    switch (sort) {
      case 'popular':
        return { soldCount: -1, _id: -1 };
      // An array sorts by its lowest value going up and its highest going down.
      case 'price_asc':
        return { 'variants.priceMinor': 1, _id: -1 };
      case 'price_desc':
        return { 'variants.priceMinor': -1, _id: -1 };
      case 'newest':
        return { createdAt: -1, _id: -1 };
    }
  }

  async productList(q: {
    category?: string;
    q?: string;
    sort: 'newest' | 'popular' | 'price_asc' | 'price_desc';
    page: number;
    limit: number;
  }) {
    const filter: Record<string, unknown> = { status: 'active' };
    let category: CategoryDoc | null = null;
    if (q.category) {
      category = await this.categories.findOne({ slug: q.category.toLowerCase() });
      if (!category) return { items: [], total: 0, page: q.page, pageCount: 0, category: null };
      filter.categoryId = category._id;
    }
    if (q.q) filter.searchText = { $regex: escapeRegex(q.q.normalize('NFKC').toLowerCase()) };
    const [docs, total] = await Promise.all([
      this.products.find(filter, {
        sort: this.sortFor(q.sort),
        skip: (q.page - 1) * q.limit,
        limit: q.limit,
      }),
      this.products.count(filter),
    ]);
    return {
      items: docs.map((p) => this.card(p)),
      total,
      page: q.page,
      pageCount: Math.ceil(total / q.limit),
      category: category ? { name: category.name, slug: category.slug } : null,
    };
  }

  async product(slug: string) {
    const p = await this.products.findOne({ slug: slug.toLowerCase(), status: 'active' });
    if (!p) throw AppError.notFound('product');
    const category = p.categoryId ? await this.categories.findById(p.categoryId) : null;
    const related = p.categoryId
      ? await this.products.find(
          { status: 'active', categoryId: p.categoryId, _id: { $ne: p._id } },
          { sort: { soldCount: -1, _id: -1 }, limit: 4 },
        )
      : [];
    return { product: this.detail(p, category), related: related.map((r) => this.card(r)) };
  }

  /** Products for each enabled products section of the home page, by section id. */
  async home(r: ResolvedStore) {
    const sections: Record<string, ReturnType<StorefrontService['card']>[]> = {};
    for (const s of r.store.theme.sections) {
      if (!s.enabled || s.type !== 'products') continue;
      const filter: Record<string, unknown> = { status: 'active' };
      if (s.source === 'category') {
        if (!s.categoryId) continue;
        filter.categoryId = new Types.ObjectId(s.categoryId);
      }
      const docs = await this.products.find(filter, {
        sort: this.sortFor(s.source === 'bestsellers' ? 'popular' : 'newest'),
        limit: Math.min(s.limit, SECTION_LIMIT_MAX),
      });
      sections[s.id] = docs.map((p) => this.card(p));
    }
    const hasCategories = r.store.theme.sections.some((s) => s.enabled && s.type === 'categories');
    return { sections, categories: hasCategories ? await this.categoryList() : [] };
  }

  page(r: ResolvedStore, key: StorePageKey) {
    const text = r.store.pages[key]?.trim();
    if (!text) throw AppError.notFound('page');
    return { key, text };
  }

  async sitemap(r: ResolvedStore) {
    const [products, categories] = await Promise.all([
      this.products.find(
        { status: 'active' },
        { sort: { updatedAt: -1 }, limit: SITEMAP_MAX, projection: { slug: 1, updatedAt: 1 } },
      ),
      this.categoryList(),
    ]);
    return {
      products: products.map((p) => ({ slug: p.slug, updatedAt: p.updatedAt.toISOString() })),
      categories: categories.map((c) => c.slug),
      pages: PAGE_KEYS.filter((k) => Boolean(r.store.pages[k]?.trim())),
      updatedAt: r.store.updatedAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------- cart and checkout

  /**
   * Prices a cart from the catalog as it is now. Lines that cannot be bought (gone, archived,
   * out of stock, more than in stock) come back with a problem instead of failing the cart,
   * so the storefront can tell the shopper what changed.
   */
  async quote(r: ResolvedStore, items: CartLineInput[], zoneId?: string | null) {
    const ids = [...new Set(items.map((i) => i.productId))].map((i) => new Types.ObjectId(i));
    const [products, settings] = await Promise.all([
      ids.length ? this.products.find({ _id: { $in: ids } }) : Promise.resolve([]),
      this.shopSettings.get(),
    ]);
    const byId = new Map(products.map((p) => [p._id.toHexString(), p]));
    const seen = new Set<string>();
    const lines = items.map((i) => {
      const p = byId.get(i.productId);
      const v = p?.variants.find((x) => x._id.toHexString() === i.variantId);
      const base = { productId: i.productId, variantId: i.variantId, quantity: i.quantity };
      if (!p || !v || p.status !== 'active' || p.currency !== r.org.currency)
        return { ...base, problem: 'unavailable' as const, name: p?.name ?? null };
      const duplicate = seen.has(i.variantId);
      seen.add(i.variantId);
      const max = v.trackStock ? Math.max(0, v.stock) : null;
      const problem = duplicate
        ? ('duplicate' as const)
        : max === 0
          ? ('out_of_stock' as const)
          : max !== null && i.quantity > max
            ? ('not_enough_stock' as const)
            : null;
      return {
        ...base,
        name: p.name,
        slug: p.slug,
        variantTitle: v.title === 'Default' ? '' : v.title,
        image: p.images[0]?.url ?? null,
        unitPriceMinor: v.priceMinor,
        totalMinor: v.priceMinor * i.quantity,
        maxQuantity: max,
        problem,
      };
    });
    const ok = lines.filter((l) => l.problem === null);
    const subtotalMinor = ok.reduce((a, l) => a + ('totalMinor' in l ? l.totalMinor : 0), 0);
    const zones = settings.deliveryZones.map((z) => ({
      id: z.id,
      name: z.name,
      chargeMinor: z.chargeMinor,
    }));
    const chosen =
      zoneId === undefined
        ? zones.find((z) => z.id === settings.defaultZoneId)
        : zones.find((z) => z.id === zoneId);
    const deliveryChargeMinor = ok.length && chosen ? chosen.chargeMinor : 0;
    const minOrderMinor = r.store.checkout.minOrderMinor ?? 0;
    return {
      currency: r.org.currency,
      lines,
      subtotalMinor,
      zones,
      zoneId: chosen?.id ?? null,
      deliveryChargeMinor,
      totalMinor: subtotalMinor + deliveryChargeMinor,
      minOrderMinor,
      belowMinimum: minOrderMinor > 0 && subtotalMinor < minOrderMinor,
      canCheckout:
        ok.length > 0 &&
        ok.length === lines.length &&
        !(minOrderMinor > 0 && subtotalMinor < minOrderMinor) &&
        (zones.length === 0 || Boolean(chosen)),
    };
  }

  /**
   * Places an order from the store. Safe to retry with the same Idempotency-Key: the first
   * answer is kept for a day and returned again; the same key with a different cart is
   * refused. The order starts as pending for the business to confirm (stock is taken then).
   */
  checkout(r: ResolvedStore, input: CheckoutInput, idempotencyKey: string) {
    return runIdempotent({
      redis: this.redis,
      scope: `sf:idem:${r.store._id.toHexString()}`,
      key: idempotencyKey,
      fingerprint: sha256(
        canonicalJson({
          ...input,
          website: undefined,
          cartToken: undefined,
          attribution: undefined,
        }),
      ),
      before: async () => {
        const ip = RequestContext.current()?.ip;
        if (ip) await this.limits.consume('checkout:ip', ip);
        // Bots fill every field; people never see this one. Refused without saying why.
        if (input.website?.trim())
          throw AppError.unprocessable(
            'order_not_accepted',
            'We could not take this order online. Please call the shop.',
          );
      },
      run: () => this.placeOrder(r, input),
    });
  }

  private async placeOrder(r: ResolvedStore, input: CheckoutInput) {
    const { phone } = await this.customers.normalizePhones(
      { phone: input.customer.phone },
      'customer.',
    );
    await this.limits.consume('checkout:phone', `${r.org._id.toHexString()}:${phone}`);

    const quote = await this.quote(r, input.items, input.zoneId);
    const errors: FieldError[] = [];
    quote.lines.forEach((l, i) => {
      if (l.problem)
        errors.push({
          path: `items.${i}`,
          code: l.problem,
          message: lineMessage(l.problem, l.name),
        });
    });
    if (errors.length)
      throw AppError.conflict(
        'cart_changed',
        'Some items in the cart changed. Check the cart and try again.',
        {
          errors,
          quote,
        },
      );
    if (quote.zones.length && !quote.zoneId)
      throw AppError.validation([{ path: 'zoneId', message: 'Choose a delivery area' }]);
    if (quote.belowMinimum)
      throw AppError.unprocessable('below_minimum', 'The cart is below the minimum order.', {
        minOrderMinor: quote.minOrderMinor,
      });
    const plan = this.shopPayments.plan(
      input.payment,
      await this.shopPayments.options({
        totalMinor: quote.totalMinor,
        deliveryChargeMinor: quote.deliveryChargeMinor,
        zoneId: quote.zoneId,
        currency: quote.currency,
      }),
    );

    let order: OrderDoc;
    try {
      order = await this.orders.create({
        customer: {
          name: input.customer.name,
          phone,
          ...(input.customer.email ? { email: input.customer.email } : {}),
        },
        shippingAddress: {
          name: input.customer.name,
          phone,
          line1: input.address.line1,
          ...(input.address.area ? { area: input.address.area } : {}),
          ...(input.address.city ? { city: input.address.city } : {}),
          ...(input.address.district ? { district: input.address.district } : {}),
        },
        items: input.items.map((i) => ({
          productId: i.productId,
          variantId: i.variantId,
          quantity: i.quantity,
        })),
        deliveryZoneId: quote.zoneId,
        payment: { method: plan.method, ...(plan.online ? { online: plan.online } : {}) },
        ...(input.note ? { customerNote: input.note } : {}),
        status: 'pending',
        source: 'store',
        customerSource: 'store',
        storeId: r.store._id.toHexString(),
        ...(input.attribution && Object.keys(input.attribution).length
          ? { attribution: input.attribution }
          : {}),
      });
    } catch (err) {
      // A blocked customer gets the same answer as anyone the shop cannot serve online.
      if (err instanceof AppError && err.code === 'customer_blocked')
        throw AppError.unprocessable(
          'order_not_accepted',
          'We could not take this order online. Please call the shop.',
        );
      if (err instanceof AppError && err.code === 'plan_limit_reached') {
        this.logger.warn(
          { orgId: r.org._id.toHexString() },
          'Store order refused: monthly order limit',
        );
        throw AppError.unprocessable(
          'order_not_accepted',
          'We could not take this order online. Please call the shop.',
        );
      }
      throw err;
    }
    await this.closeCart(input.cartToken, order);
    await this.stats.orderPlaced(r, order, input.attribution);
    const receipt = this.links.receiptToken(r.store._id.toHexString(), order._id.toHexString());
    return {
      orderNumber: order.number,
      totalMinor: order.totalMinor,
      currency: order.currency,
      receipt,
      payment: plan.online
        ? await this.startPayment(r, order, plan.online.gateway, this.receiptUrl(r, receipt, true))
        : null,
    };
  }

  /** The shop's receipt page for an order; `fresh` shows the thank-you message on it. */
  receiptUrl(r: ResolvedStore, receipt: string, fresh: boolean): string {
    return `${this.links.url(r.store).replace(/\/$/, '')}/order?receipt=${encodeURIComponent(receipt)}${fresh ? '&new=1' : ''}`;
  }

  /** Starts the online payment of an order with the business's own gateway (ADR 0029). */
  startPayment(
    r: ResolvedStore,
    order: OrderDoc,
    gateway: ShopGatewayKey,
    returnUrl: string,
  ): Promise<PaymentStart> {
    return this.shopPayments.start(order, gateway, {
      returnUrl,
      description: `Order ${order.number} · ${r.store.name}`,
    });
  }

  /**
   * "Pay now" on a receipt: a new attempt for what is still due online, with a gateway the
   * shopper chooses. Limited per order.
   */
  async pay(
    r: ResolvedStore,
    receipt: string,
    gateway: ShopGatewayKey,
    returnUrl?: string,
  ): Promise<PaymentStart> {
    const orderId = this.links.verifyReceipt(r.store._id.toHexString(), receipt);
    const order = orderId ? await this.orderRepo.findById(orderId) : null;
    if (!order) throw AppError.notFound('order');
    await this.limits.consume('shop-pay:order', order._id.toHexString());
    return this.startPayment(r, order, gateway, returnUrl ?? this.receiptUrl(r, receipt, false));
  }

  /** Closes the saved cart an order came from. Never fails the order. */
  async closeCart(token: string | undefined, order: OrderDoc): Promise<void> {
    try {
      await this.carts.checkedOut(token, order);
    } catch (err) {
      this.logger.error({ err, orderId: order._id.toHexString() }, 'Could not close the cart');
    }
  }

  // ---------------------------------------------------------------- abandoned carts

  /** A cart price for the checkout page, and whether the cart may be saved for reminders. */
  async cartQuote(r: ResolvedStore, items: CartLineInput[], zoneId?: string | null) {
    const quote = await this.quote(r, items, zoneId);
    const [cartReminders, payments] = await Promise.all([
      this.carts.capturing(),
      this.shopPayments.options({
        totalMinor: quote.totalMinor,
        deliveryChargeMinor: quote.deliveryChargeMinor,
        zoneId: quote.zoneId,
        currency: quote.currency,
      }),
    ]);
    return { ...quote, cartReminders: r.state === 'open' && cartReminders, payments };
  }

  /**
   * Saves the checkout's cart for reminders once the shopper has typed a number (ADR 0018).
   * Lines the store no longer sells are left out; prices are the store's prices now.
   */
  async saveCart(
    r: ResolvedStore,
    input: { token: string; items: CartLineInput[]; customer: { name: string; phone: string } },
  ) {
    const quote = await this.quote(r, input.items, undefined);
    const lines = quote.lines.flatMap((l) =>
      'unitPriceMinor' in l && l.problem !== 'duplicate'
        ? [
            {
              productId: l.productId,
              variantId: l.variantId,
              quantity: l.quantity,
              name: l.name,
              variantTitle: l.variantTitle,
              unitPriceMinor: l.unitPriceMinor,
            },
          ]
        : [],
    );
    return this.carts.capture({
      source: 'store',
      store: { id: r.store._id, name: r.store.name, url: this.links.url(r.store) },
      token: input.token,
      phone: input.customer.phone,
      name: input.customer.name,
      items: lines,
      totalMinor: lines.reduce((a, l) => a + l.unitPriceMinor * l.quantity, 0),
      currency: r.org.currency,
    });
  }

  /** The cart behind a reminder link on this store; 404 when it is not this store's. */
  async restoreCart(r: ResolvedStore, code: string) {
    const found = await this.carts.restore(r.store._id, code);
    if (!found) throw AppError.notFound('cart', 'This link is not valid.');
    return found;
  }

  // ---------------------------------------------------------------- after the order

  private shipmentView(o: OrderDoc) {
    if (!o.shipment) return null;
    let providerName: string = o.shipment.provider;
    let trackingUrl: string | null = null;
    try {
      const provider = this.couriers.provider(o.shipment.provider as CourierKey);
      providerName = provider.descriptor.name;
      if (o.shipment.consignmentId || o.shipment.trackingCode)
        trackingUrl = provider.trackingUrl({
          ...(o.shipment.consignmentId ? { consignmentId: o.shipment.consignmentId } : {}),
          ...(o.shipment.trackingCode ? { trackingCode: o.shipment.trackingCode } : {}),
          phone: o.customer.phone ?? '',
        });
    } catch {
      // A courier Sellora no longer supports: show its key and no link.
    }
    return {
      status: o.shipment.status,
      courier: providerName,
      trackingCode: o.shipment.trackingCode ?? o.shipment.consignmentId ?? null,
      trackingUrl,
    };
  }

  private timeline(o: OrderDoc) {
    return o.history.map((h) => ({ status: h.status, at: h.at.toISOString() }));
  }

  /** The order a receipt link shows. */
  async receipt(r: ResolvedStore, token: string) {
    const orderId = this.links.verifyReceipt(r.store._id.toHexString(), token);
    const order = orderId ? await this.orderRepo.findById(orderId) : null;
    if (!order) throw AppError.notFound('order');
    return {
      number: order.number,
      status: order.status,
      placedAt: order.placedAt.toISOString(),
      currency: order.currency,
      items: order.items.map((i) => ({
        name: i.name,
        variantTitle: i.variantTitle,
        image: i.imageUrl ?? null,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
        totalMinor: i.totalMinor,
      })),
      subtotalMinor: order.subtotalMinor,
      discountMinor: order.discountMinor,
      deliveryChargeMinor: order.deliveryChargeMinor,
      totalMinor: order.totalMinor,
      paymentMethod: order.payment.method,
      payment: await this.shopPayments.receiptView(order),
      customer: { name: order.customer.name, phone: maskPhone(order.customer.phone) },
      address: {
        line1: order.shippingAddress.line1,
        area: order.shippingAddress.area ?? null,
        city: order.shippingAddress.city ?? null,
        district: order.shippingAddress.district ?? null,
      },
      deliveryZone: order.deliveryZone?.name ?? null,
      timeline: this.timeline(order),
      shipment: this.shipmentView(order),
    };
  }

  /**
   * Order status for a shopper who knows the order number and the phone it was placed
   * with. A wrong number and a wrong phone look the same, so numbers cannot be probed.
   */
  async track(r: ResolvedStore, number: string, rawPhone: string) {
    const ip = RequestContext.current()?.ip;
    if (ip) await this.limits.consume('track:ip', ip);
    let phone: string | undefined;
    try {
      phone = (await this.customers.normalizePhones({ phone: rawPhone })).phone;
    } catch {
      phone = undefined;
    }
    const order = phone
      ? await this.orderRepo.findOne({
          number: { $in: [...new Set([number.trim(), number.trim().toUpperCase()])] },
          'customer.phone': phone,
        })
      : null;
    if (!order) throw AppError.notFound('order', 'No order matches this number and phone number.');
    return {
      number: order.number,
      status: order.status,
      placedAt: order.placedAt.toISOString(),
      totalMinor: order.totalMinor,
      currency: order.currency,
      itemCount: order.items.reduce((a, i) => a + i.quantity, 0),
      timeline: this.timeline(order),
      shipment: this.shipmentView(order),
    };
  }

  // ---------------------------------------------------------------- TLS

  /**
   * Whether a TLS certificate may be issued for `domain` (the web server asks before
   * getting one on demand): only for hosts that are a store's address.
   */
  async domainIsStore(domain: string): Promise<boolean> {
    const parsed = parseStoreHost(domain, this.links.baseDomain().replace(/:\d+$/, ''));
    if (!parsed) return false;
    if (parsed.kind === 'custom') return (await this.domains.activeStoreId(parsed.host)) !== null;
    const found = await this.storeModel
      .exists({ handle: parsed.handle })
      .setOptions({ [CROSS_TENANT]: true })
      .exec();
    return found !== null;
  }
}

function lineMessage(problem: string, name: string | null): string {
  const item = name ?? 'An item';
  switch (problem) {
    case 'out_of_stock':
      return `${item} is out of stock`;
    case 'not_enough_stock':
      return `There is not enough ${item} in stock`;
    case 'duplicate':
      return `${item} is in the cart twice`;
    default:
      return `${item} is no longer available`;
  }
}
