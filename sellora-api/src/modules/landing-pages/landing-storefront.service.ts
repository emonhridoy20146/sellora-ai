import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { canonicalJson, sha256 } from '../../common/crypto/tokens.js';
import { AppError } from '../../common/errors/app-error.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { CartsService } from '../carts/carts.service.js';
import { CustomersService } from '../commerce/customers.service.js';
import { OrdersService, type OrderDoc } from '../commerce/orders.service.js';
import { OrderRepository, ProductRepository } from '../commerce/repositories.js';
import type { OrderAttribution, Product } from '../commerce/schemas.js';
import { ShopSettingsService } from '../commerce/shop-settings.service.js';
import { runIdempotent } from '../stores/idempotency.js';
import { StoreLinksService } from '../stores/store-links.service.js';
import { StorefrontService, type ResolvedStore } from '../stores/storefront.service.js';
import {
  dayKey,
  MAX_FREE_QUANTITY,
  packageCharge,
  parseVideoUrl,
  type LandingContent,
  type LandingSection,
} from './blocks.js';
import type { LandingPageDoc } from './landing-pages.service.js';
import { LandingPageRepository, LandingPageStatRepository } from './repositories.js';

type ProductDoc = WithId<Product>;

/**
 * What a shopper sees at a page's address. `live` and `preview` show the page; `paused`
 * (by the business, or its store is paused) and `unavailable` (taken down, store suspended,
 * business inactive, plan without landing pages) show a short "not available" page.
 */
export type LandingState = 'live' | 'preview' | 'paused' | 'unavailable';

export interface ResolvedLanding {
  store: ResolvedStore;
  page: LandingPageDoc;
  state: LandingState;
  /** What is shown: the published version, or the draft or snapshot in a preview. */
  content: LandingContent | null;
}

export interface LandingOrderInput {
  /** Required when the page sells packages; ignored otherwise. */
  packageId: string | null;
  variantId: string;
  /** Used when the page has no packages (1 to MAX_FREE_QUANTITY). */
  quantity: number;
  addOn: boolean;
  customer: { name: string; phone: string };
  address: { line1: string; area?: string; city?: string; district?: string };
  zoneId: string | null;
  note?: string;
  website?: string;
  attribution?: OrderAttribution;
  /** The saved cart this order comes from (ADR 0018), closed when the order is made. */
  cartToken?: string;
}

export interface LandingCartInput {
  token: string;
  packageId: string | null;
  variantId: string;
  quantity: number;
  addOn: boolean;
  customer: { name: string; phone: string };
}

/** Same phone, same page, still pending, within this window: the first receipt is shown again. */
export const DUPLICATE_WINDOW_MS = 15 * 60_000;
/** A visitor is counted once per page and day; the marker outlives the day by a little. */
const VISIT_TTL_S = 2 * 86_400;

const NOT_ACCEPTED = 'We could not take this order online. Please call the shop.';

/**
 * Landing pages for shoppers (ADR 0016): the page at `<store address>/<slug>`, its visit
 * counter, and its order form. Called only by the storefront app with the storefront key.
 * Prices come from the published page and the catalog as they are now; the browser only
 * says which package, option and add-on the shopper chose.
 */
@Injectable()
export class LandingStorefrontService {
  private readonly logger = new Logger(LandingStorefrontService.name);

  constructor(
    private readonly storefront: StorefrontService,
    private readonly pages: LandingPageRepository,
    private readonly stats: LandingPageStatRepository,
    private readonly products: ProductRepository,
    private readonly orderRepo: OrderRepository,
    private readonly orders: OrdersService,
    private readonly customers: CustomersService,
    private readonly shopSettings: ShopSettingsService,
    private readonly entitlements: EntitlementsService,
    private readonly links: StoreLinksService,
    private readonly limits: RateLimitService,
    private readonly carts: CartsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ---------------------------------------------------------------- finding the page

  /** Whether the business and store may show landing pages at all. */
  private async available(r: ResolvedStore): Promise<boolean> {
    const { org, store } = r;
    if (org.status !== 'active') return false;
    if (org.isDemo && org.demoExpiresAt && org.demoExpiresAt <= new Date()) return false;
    if (store.status === 'suspended') return false;
    return this.entitlements.hasModule(org._id.toHexString(), 'landing_pages');
  }

  /** The page at `slug` on the store at `host`; null when there is no such page. */
  async resolve(
    host: string,
    slug: string,
    previewToken?: string,
  ): Promise<ResolvedLanding | null> {
    const store = await this.storefront.resolve(host);
    if (!store) return null;
    const page = await this.storefront.inStore(store, () =>
      this.pages.findOne({ storeId: store.store._id, slug: slug.toLowerCase() }),
    );
    if (!page) return null;
    if (!(await this.available(store))) return { store, page, state: 'unavailable', content: null };
    const preview = this.links.verifyLandingPreview(previewToken);
    if (preview && preview.pageId === page._id.toHexString()) {
      const content =
        preview.kind === 'submission' && page.submission ? page.submission.content : page.draft;
      return { store, page, state: 'preview', content };
    }
    if (page.takedown) return { store, page, state: 'unavailable', content: null };
    // A page that was never published does not exist for shoppers.
    if (!page.published) return null;
    if (page.paused || store.store.status === 'paused')
      return { store, page, state: 'paused', content: null };
    return { store, page, state: 'live', content: page.published.content };
  }

  async require(host: string, slug: string, previewToken?: string): Promise<ResolvedLanding> {
    const found = await this.resolve(host, slug, previewToken);
    if (!found) throw AppError.notFound('landing_page');
    return found;
  }

  /** Runs `fn` in the page's business, as a shopper. */
  inPage<T>(l: ResolvedLanding, fn: () => Promise<T>): Promise<T> {
    return this.storefront.inStore(l.store, fn);
  }

  // ---------------------------------------------------------------- what the page shows

  /** The store's look and contact details, for the page's header and footer. */
  private brand(r: ResolvedStore) {
    const { store, org } = r;
    return {
      id: store._id.toHexString(),
      name: store.name,
      handle: store.handle,
      url: this.links.url(store),
      language: store.language,
      /** Whether the rest of the shop is open (links to it are shown only then). */
      open: store.status === 'live',
      themeKey: store.themeKey,
      theme: { ...store.theme, sections: [], announcement: '' },
      currency: org.currency,
      contact: {
        phone: store.contact.phone ?? null,
        whatsapp: store.contact.whatsapp ?? null,
        email: store.contact.email ?? null,
        address: store.contact.address ?? null,
      },
    };
  }

  private productView(p: ProductDoc) {
    return {
      id: p._id.toHexString(),
      name: p.name,
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
        /** Most a shopper can order; null when stock is not counted. */
        maxQuantity: v.trackStock ? Math.max(0, v.stock) : null,
      })),
      currency: p.currency,
    };
  }

  /** Units left across the product's options, when every option counts stock. */
  private stockLeft(p: ProductDoc): number | null {
    if (p.variants.some((v) => !v.trackStock)) return null;
    return p.variants.reduce((a, v) => a + Math.max(0, v.stock), 0);
  }

  /** Enabled sections only, with video links reduced to what the player needs. */
  private sections(content: LandingContent) {
    return content.sections
      .filter((s) => s.enabled)
      .map((s): LandingSection & { embed?: ReturnType<typeof parseVideoUrl> } =>
        s.type === 'video' ? { ...s, embed: parseVideoUrl(s.url) } : s,
      );
  }

  /** Everything the storefront needs to render the page (or its "not available" page). */
  async view(l: ResolvedLanding) {
    const { page, state } = l;
    const head = {
      state,
      store: this.brand(l.store),
      page: {
        id: page._id.toHexString(),
        name: page.name,
        slug: page.slug,
        language: page.language,
        url: `${this.links.url(l.store.store)}/${page.slug}`,
      },
    };
    if (!l.content || (state !== 'live' && state !== 'preview')) return head;
    const content = l.content;
    return this.inPage(l, async () => {
      const { offer } = content;
      const ids = [offer.productId, offer.addOn?.productId].filter((x): x is string => Boolean(x));
      const [found, settings] = await Promise.all([
        ids.length
          ? this.products.find({ _id: { $in: ids.map((i) => new Types.ObjectId(i)) } })
          : Promise.resolve([] as ProductDoc[]),
        this.shopSettings.get(),
      ]);
      const byId = new Map(found.map((p) => [p._id.toHexString(), p]));
      const currency = l.store.org.currency;
      const sellable = (p: ProductDoc | undefined) =>
        p && p.status === 'active' && p.currency === currency ? p : undefined;
      const product = sellable(offer.productId ? byId.get(offer.productId) : undefined);
      const addOnProduct = sellable(offer.addOn ? byId.get(offer.addOn.productId) : undefined);
      const addOnVariant = addOnProduct?.variants.find(
        (v) => v._id.toHexString() === offer.addOn?.variantId,
      );
      const stockSection = content.sections.find((s) => s.enabled && s.type === 'stock_left');
      const left = product ? this.stockLeft(product) : null;
      return {
        ...head,
        sections: this.sections(content),
        settings: content.settings,
        seo: {
          title: content.seo.title || page.name,
          description: content.seo.description,
          image: content.seo.image?.url ?? product?.images[0]?.url ?? null,
          // Previews are never listed by search engines.
          index: state === 'live' && content.seo.index,
        },
        product: product ? this.productView(product) : null,
        packages: offer.packages,
        maxFreeQuantity: MAX_FREE_QUANTITY,
        addOn:
          offer.addOn &&
          addOnProduct &&
          addOnVariant &&
          (!addOnVariant.trackStock || addOnVariant.stock > 0)
            ? {
                label: offer.addOn.label,
                name: addOnProduct.name,
                variantTitle: addOnVariant.title === 'Default' ? '' : addOnVariant.title,
                image: addOnProduct.images[0]?.url ?? null,
                priceMinor: offer.addOn.priceMinor,
                regularPriceMinor: addOnVariant.priceMinor,
              }
            : null,
        noteField: offer.noteField,
        // Exact stock is shown only as low as the page's "stock left" section asks.
        stockLeft:
          stockSection &&
          stockSection.type === 'stock_left' &&
          left !== null &&
          left <= stockSection.threshold
            ? left
            : null,
        zones: settings.deliveryZones.map((z) => ({
          id: z.id,
          name: z.name,
          chargeMinor: z.chargeMinor,
        })),
        defaultZoneId: settings.defaultZoneId,
        currency,
        // The order form says reminders may come only when the business has them on.
        cartReminders: state === 'live' && (await this.carts.capturing()),
      };
    });
  }

  /** Live pages of the store that search engines may list, for its sitemap. */
  async sitemap(host: string) {
    const r = await this.storefront.resolve(host);
    if (!r || !(await this.available(r)) || r.store.status === 'paused') return { items: [] };
    const pages = await this.storefront.inStore(r, () =>
      this.pages.find(
        {
          storeId: r.store._id,
          published: { $exists: true },
          paused: false,
          takedown: { $exists: false },
        },
        {
          projection: {
            slug: 1,
            'published.publishedAt': 1,
            'published.content.seo.index': 1,
          } as never,
        },
      ),
    );
    return {
      items: pages
        .filter((p) => p.published?.content.seo.index !== false)
        .map((p) => ({ slug: p.slug, updatedAt: p.published!.publishedAt.toISOString() })),
    };
  }

  // ---------------------------------------------------------------- visits

  /**
   * Counts a visitor once per page and day. `visitorId` is a random id the browser keeps;
   * without one the shopper's address stands in. Previews and closed pages count nothing.
   */
  async visit(l: ResolvedLanding, visitorId: string | undefined): Promise<{ counted: boolean }> {
    if (l.state !== 'live') return { counted: false };
    const ip = RequestContext.current()?.ip;
    if (ip) await this.limits.consume('landing-visit:ip', ip);
    const who = visitorId || ip;
    if (!who) return { counted: false };
    const day = dayKey(new Date(), l.store.org.timezone);
    const key = `lp:visit:${l.page._id.toHexString()}:${day}:${sha256(who).slice(0, 32)}`;
    const first = await this.redis.set(key, '1', 'EX', VISIT_TTL_S, 'NX');
    if (first !== 'OK') return { counted: false };
    await this.inPage(l, () => this.bump(l.page._id, day, { visitors: 1 }));
    return { counted: true };
  }

  private async bump(
    pageId: Types.ObjectId,
    day: string,
    inc: Partial<Record<'visitors' | 'orders' | 'revenueMinor', number>>,
  ) {
    await this.stats.findOneAndUpdate({ pageId, day }, { $inc: inc }, { upsert: true });
  }

  // ---------------------------------------------------------------- orders

  /**
   * Places a cash-on-delivery order from the page's form. Safe to retry with the same
   * Idempotency-Key (as store checkout); a second order from the same phone on the same page
   * within 15 minutes, while the first is still pending, returns the first one's receipt.
   */
  order(l: ResolvedLanding, input: LandingOrderInput, idempotencyKey: string) {
    if (l.state !== 'live')
      throw AppError.conflict('offer_not_available', 'This offer is not available right now.');
    return runIdempotent({
      redis: this.redis,
      scope: `lp:idem:${l.page._id.toHexString()}`,
      key: idempotencyKey,
      fingerprint: sha256(
        canonicalJson({
          ...input,
          website: undefined,
          attribution: undefined,
          cartToken: undefined,
        }),
      ),
      before: async () => {
        const ip = RequestContext.current()?.ip;
        if (ip) await this.limits.consume('checkout:ip', ip);
        // Bots fill every field; people never see this one. Refused without saying why.
        if (input.website?.trim()) throw AppError.unprocessable('order_not_accepted', NOT_ACCEPTED);
      },
      run: () => this.inPage(l, () => this.placeOrder(l, input)),
    });
  }

  private async placeOrder(l: ResolvedLanding, input: LandingOrderInput) {
    const { store, org } = l.store;
    const page = l.page;
    const content = l.content!;
    const { offer } = content;
    const { phone } = await this.customers.normalizePhones(
      { phone: input.customer.phone },
      'customer.',
    );
    await this.limits.consume('checkout:phone', `${org._id.toHexString()}:${phone}`);

    const previous = await this.orderRepo.findOne(
      {
        source: 'landing_page',
        'landingPage.id': page._id.toHexString(),
        'customer.phone': phone,
        status: 'pending',
        placedAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      undefined,
      { sort: { placedAt: -1 } },
    );
    if (previous) return this.placed(l, previous, true);

    const unavailable = () =>
      AppError.conflict('offer_not_available', 'This offer is not available right now.');
    const product = offer.productId ? await this.products.findById(offer.productId) : null;
    if (!product || product.status !== 'active' || product.currency !== org.currency)
      throw unavailable();
    const variant = product.variants.find((v) => v._id.toHexString() === input.variantId);
    if (!variant)
      throw AppError.validation([{ path: 'variantId', message: 'Choose one of the options' }]);

    let quantity: number;
    let packagePrice: number | null = null;
    let packageLabel: string | null = null;
    if (offer.packages.length) {
      const pkg = offer.packages.find((p) => p.id === input.packageId);
      if (!pkg)
        throw AppError.validation([{ path: 'packageId', message: 'Choose one of the packages' }]);
      quantity = pkg.quantity;
      packagePrice = pkg.priceMinor;
      packageLabel = pkg.label;
    } else {
      if (input.quantity < 1 || input.quantity > MAX_FREE_QUANTITY)
        throw AppError.validation([
          { path: 'quantity', message: `Order between 1 and ${MAX_FREE_QUANTITY}` },
        ]);
      quantity = input.quantity;
    }
    if (variant.trackStock && variant.stock < quantity)
      throw AppError.conflict(
        variant.stock > 0 ? 'not_enough_stock' : 'out_of_stock',
        variant.stock > 0
          ? `Only ${variant.stock} left. Choose a smaller package.`
          : 'This option is sold out.',
        { left: Math.max(0, variant.stock) },
      );
    const main = packageCharge(variant.priceMinor, quantity, packagePrice);
    const items = [
      {
        productId: product._id.toHexString(),
        variantId: variant._id.toHexString(),
        quantity,
        unitPriceMinor: main.unitPriceMinor,
      },
    ];
    let discountMinor = main.discountMinor;

    if (input.addOn && offer.addOn) {
      const extra = await this.products.findById(offer.addOn.productId);
      const extraVariant = extra?.variants.find(
        (v) => v._id.toHexString() === offer.addOn!.variantId,
      );
      if (
        !extra ||
        !extraVariant ||
        extra.status !== 'active' ||
        extra.currency !== org.currency ||
        (extraVariant.trackStock && extraVariant.stock < 1)
      )
        throw AppError.conflict(
          'add_on_unavailable',
          'The extra item is no longer available. Untick it and order again.',
        );
      const charge = packageCharge(extraVariant.priceMinor, 1, offer.addOn.priceMinor);
      items.push({
        productId: extra._id.toHexString(),
        variantId: extraVariant._id.toHexString(),
        quantity: 1,
        unitPriceMinor: charge.unitPriceMinor,
      });
      discountMinor += charge.discountMinor;
    }

    const settings = await this.shopSettings.get();
    if (settings.deliveryZones.length) {
      if (!input.zoneId || !settings.deliveryZones.some((z) => z.id === input.zoneId))
        throw AppError.validation([{ path: 'zoneId', message: 'Choose a delivery area' }]);
    }

    const note = [packageLabel ? `Package: ${packageLabel}` : '', input.note?.trim() ?? '']
      .filter(Boolean)
      .join('\n');
    let order: OrderDoc;
    try {
      order = await this.orders.create({
        customer: { name: input.customer.name, phone },
        shippingAddress: {
          name: input.customer.name,
          phone,
          line1: input.address.line1,
          ...(input.address.area ? { area: input.address.area } : {}),
          ...(input.address.city ? { city: input.address.city } : {}),
          ...(input.address.district ? { district: input.address.district } : {}),
        },
        items,
        discountMinor,
        deliveryZoneId: settings.deliveryZones.length ? input.zoneId : null,
        payment: { method: 'cod' },
        ...(note ? { customerNote: note } : {}),
        status: 'pending',
        source: 'landing_page',
        customerSource: 'store',
        storeId: store._id.toHexString(),
        landingPage: { id: page._id.toHexString(), name: page.name, slug: page.slug },
        ...(input.attribution && Object.keys(input.attribution).length
          ? { attribution: input.attribution }
          : {}),
      });
    } catch (err) {
      // A blocked customer gets the same answer as anyone the shop cannot serve online.
      if (err instanceof AppError && err.code === 'customer_blocked')
        throw AppError.unprocessable('order_not_accepted', NOT_ACCEPTED);
      if (err instanceof AppError && err.code === 'plan_limit_reached') {
        this.logger.warn(
          { orgId: org._id.toHexString(), pageId: page._id.toHexString() },
          'Landing page order refused: monthly order limit',
        );
        throw AppError.unprocessable('order_not_accepted', NOT_ACCEPTED);
      }
      throw err;
    }
    await this.bump(page._id, dayKey(order.placedAt, org.timezone), {
      orders: 1,
      revenueMinor: order.totalMinor,
    });
    await this.storefront.closeCart(input.cartToken, order);
    return this.placed(l, order, false);
  }

  /**
   * Saves the order form's choice for reminders once the shopper has typed a number
   * (ADR 0018), priced the way the order would be. Only on live pages.
   */
  async saveCart(l: ResolvedLanding, input: LandingCartInput): Promise<{ saved: boolean }> {
    if (l.state !== 'live' || !l.content) return { saved: false };
    const { offer } = l.content;
    const { org, store } = l.store;
    return this.inPage(l, async () => {
      const product = offer.productId ? await this.products.findById(offer.productId) : null;
      const variant = product?.variants.find((v) => v._id.toHexString() === input.variantId);
      if (!product || !variant || product.status !== 'active' || product.currency !== org.currency)
        return { saved: false };
      const pkg = offer.packages.length
        ? offer.packages.find((p) => p.id === input.packageId)
        : undefined;
      if (offer.packages.length && !pkg) return { saved: false };
      const quantity = pkg
        ? pkg.quantity
        : Math.min(Math.max(1, input.quantity), MAX_FREE_QUANTITY);
      const main = packageCharge(variant.priceMinor, quantity, pkg ? pkg.priceMinor : null);
      const lines = [
        {
          productId: product._id.toHexString(),
          variantId: variant._id.toHexString(),
          quantity,
          name: product.name,
          variantTitle: variant.title === 'Default' ? '' : variant.title,
          unitPriceMinor: main.unitPriceMinor,
        },
      ];
      let total = main.totalMinor;
      if (input.addOn && offer.addOn) {
        const extra = await this.products.findById(offer.addOn.productId);
        const extraVariant = extra?.variants.find(
          (v) => v._id.toHexString() === offer.addOn!.variantId,
        );
        if (extra && extraVariant && extra.status === 'active' && extra.currency === org.currency) {
          const charge = packageCharge(extraVariant.priceMinor, 1, offer.addOn.priceMinor);
          lines.push({
            productId: extra._id.toHexString(),
            variantId: extraVariant._id.toHexString(),
            quantity: 1,
            name: extra.name,
            variantTitle: extraVariant.title === 'Default' ? '' : extraVariant.title,
            unitPriceMinor: charge.unitPriceMinor,
          });
          total += charge.totalMinor;
        }
      }
      return this.carts.capture({
        source: 'landing_page',
        store: { id: store._id, name: store.name, url: this.links.url(store) },
        landingPage: { id: l.page._id.toHexString(), name: l.page.name, slug: l.page.slug },
        token: input.token,
        phone: input.customer.phone,
        name: input.customer.name,
        items: lines,
        selection: {
          packageId: pkg?.id ?? null,
          variantId: variant._id.toHexString(),
          quantity,
          addOn: input.addOn && lines.length > 1,
        },
        totalMinor: total,
        currency: org.currency,
      });
    });
  }

  private placed(l: ResolvedLanding, order: OrderDoc, duplicate: boolean) {
    return {
      orderNumber: order.number,
      totalMinor: order.totalMinor,
      currency: order.currency,
      receipt: this.links.receiptToken(l.store.store._id.toHexString(), order._id.toHexString()),
      /** True when this is the receipt of an order the shopper placed a moment ago. */
      duplicate,
    };
  }

  /**
   * The order a thank-you page shows. Works while the page is paused or taken down too, so a
   * shopper who just ordered still sees their order; not when the business is closed.
   */
  async receipt(l: ResolvedLanding, token: string) {
    if (!(await this.available(l.store))) throw AppError.notFound('order');
    const order = await this.inPage(l, () => this.storefront.receipt(l.store, token));
    return {
      order,
      store: this.brand(l.store),
      page: {
        id: l.page._id.toHexString(),
        name: l.page.name,
        slug: l.page.slug,
        language: l.page.language,
      },
    };
  }
}
