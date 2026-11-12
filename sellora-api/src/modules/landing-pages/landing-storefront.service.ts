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
import type { OrderAttribution, Product, ShopGatewayKey } from '../commerce/schemas.js';
import { ShopSettingsService } from '../commerce/shop-settings.service.js';
import { runIdempotent } from '../stores/idempotency.js';
import { StoreLinksService } from '../stores/store-links.service.js';
import { StorefrontService, type ResolvedStore } from '../stores/storefront.service.js';
import {
  ShopPaymentsService,
  type PaymentChoice,
  type PaymentStart,
} from '../shop-payments/shop-payments.service.js';
import {
  dayKey,
  MAX_FREE_QUANTITY,
  packageCharge,
  parseVideoUrl,
  type LandingContent,
} from './blocks.js';
import { LandingAbTestsService, type AbAssignment } from './landing-ab-tests.service.js';
import type { LandingPageDoc } from './landing-pages.service.js';
import { LandingPageRepository, LandingPageStatRepository } from './repositories.js';
import { AdDestinationsService } from '../ad-tracking/ad-destinations.service.js';
import { guardCouponTry } from '../coupons/coupon-guard.js';
import { CouponsService, type AppliedCoupon } from '../coupons/coupons.service.js';
import {
  AdEventsService,
  type BrowserEventInput,
  type BrowserIds,
} from '../ad-tracking/ad-events.service.js';

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
  /**
   * What is shown: the published version (or version B of a running A/B test), or the
   * draft or a snapshot in a preview.
   */
  content: LandingContent | null;
  /** The A/B test version this browser sees on a live page with a test (ADR 0031). */
  ab: AbAssignment | null;
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
  /** Cash on delivery (the default) or online, and the gateway (ADR 0029). */
  payment?: PaymentChoice;
  /** The browser's ad ids and the shopper's tracking choice (ADR 0030). */
  tracking?: BrowserIds;
  /** A discount code the shopper typed (ADR 0031). */
  couponCode?: string;
}

/** What the shopper chose in the order form, as the server prices it. */
export interface LandingSelection {
  packageId: string | null;
  variantId: string;
  quantity: number;
  addOn: boolean;
}

export interface LandingCouponInput extends LandingSelection {
  code: string;
  zoneId: string | null;
  /** The number typed so far, for the per-customer limit. */
  phone?: string;
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
    private readonly shopPayments: ShopPaymentsService,
    private readonly adEvents: AdEventsService,
    private readonly adDestinations: AdDestinationsService,
    private readonly coupons: CouponsService,
    private readonly abTests: LandingAbTestsService,
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

  /**
   * The page at `slug` on the store at `host`; null when there is no such page. `abVisitor`
   * is the browser's A/B id: on a page with a running test it picks the version shown.
   */
  async resolve(
    host: string,
    slug: string,
    previewToken?: string,
    abVisitor?: string,
  ): Promise<ResolvedLanding | null> {
    const store = await this.storefront.resolve(host);
    if (!store) return null;
    const page = await this.storefront.inStore(store, () =>
      this.pages.findOne({ storeId: store.store._id, slug: slug.toLowerCase() }),
    );
    if (!page) return null;
    const closed = (state: 'unavailable' | 'paused'): ResolvedLanding => ({
      store,
      page,
      state,
      content: null,
      ab: null,
    });
    if (!(await this.available(store))) return closed('unavailable');
    const preview = this.links.verifyLandingPreview(previewToken);
    if (preview && preview.pageId === page._id.toHexString()) {
      const snapshot =
        preview.kind === 'submission'
          ? page.submission?.content
          : preview.kind === 'scheduled'
            ? page.scheduled?.content
            : preview.kind === 'ab_test'
              ? page.abTest?.content
              : undefined;
      return { store, page, state: 'preview', content: snapshot ?? page.draft, ab: null };
    }
    if (page.takedown) return closed('unavailable');
    // A page that was never published does not exist for shoppers.
    if (!page.published) return null;
    if (page.paused || store.store.status === 'paused') return closed('paused');
    const ab = this.abTests.assign(page, abVisitor);
    const content =
      ab?.variant === 'b' && page.abTest ? page.abTest.content : page.published.content;
    return { store, page, state: 'live', content, ab };
  }

  async require(
    host: string,
    slug: string,
    previewToken?: string,
    abVisitor?: string,
  ): Promise<ResolvedLanding> {
    const found = await this.resolve(host, slug, previewToken, abVisitor);
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
  /**
   * The sections a shopper sees, with what the browser cannot work out: video players and
   * the real number of orders today ("orders today" shows only from its minimum).
   */
  private sections(content: LandingContent, ordersToday: number) {
    return content.sections
      .filter((s) => s.enabled && (s.type !== 'orders_today' || ordersToday >= s.minCount))
      .map((s) => {
        if (s.type === 'video' || s.type === 'video_hero')
          return { ...s, embed: parseVideoUrl(s.url) };
        if (s.type === 'video_reviews')
          return { ...s, items: s.items.map((x) => ({ ...x, embed: parseVideoUrl(x.url) })) };
        if (s.type === 'orders_today') return { ...s, count: ordersToday };
        return s;
      });
  }

  /** Orders the page took today in the business's time zone (0 without the section). */
  private async ordersToday(l: ResolvedLanding, content: LandingContent): Promise<number> {
    if (!content.sections.some((s) => s.enabled && s.type === 'orders_today')) return 0;
    const day = dayKey(new Date(), l.store.org.timezone);
    const stat = await this.stats.findOne({ pageId: l.page._id, day });
    return stat?.orders ?? 0;
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
        sections: this.sections(content, await this.ordersToday(l, content)),
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
        // How the shopper may pay (ADR 0029); the form shows the advance as they choose.
        payments: await this.shopPayments.rules(currency),
        // The order form shows a code box only when a coupon works on this page now.
        couponBox: await this.coupons.offeredAt({
          type: 'landing',
          pageId: page._id.toHexString(),
        }),
        // The business's pixels and tags (ADR 0030); previews load none.
        tracking:
          state === 'live'
            ? await this.adDestinations.publicTracking({
                type: 'landing',
                id: page._id.toHexString(),
              })
            : null,
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
    // An A/B test counts each browser once for the whole test, apart from the daily count.
    if (l.ab) await this.inPage(l, () => this.abTests.countVisit(l.ab!));
    const first = await this.redis.set(key, '1', 'EX', VISIT_TTL_S, 'NX');
    if (first !== 'OK') return { counted: false };
    await this.inPage(l, () => this.bump(l.page._id, day, { visitors: 1 }));
    return { counted: true };
  }

  /** A shopper step's server copy for the business's ad platforms (live pages only). */
  async adEvent(l: ResolvedLanding, input: BrowserEventInput): Promise<{ queued: number }> {
    if (l.state !== 'live') return { queued: 0 };
    return this.inPage(l, () =>
      this.adEvents.browserEvent(
        { type: 'landing', id: l.page._id.toHexString() },
        input,
        l.store.org.currency,
      ),
    );
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
          tracking: undefined,
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
    if (previous) return this.placed(l, previous, true, null);

    const { items, discountMinor, goodsMinor, packageLabel } = await this.priceSelection(l, input);

    const settings = await this.shopSettings.get();
    const zone = settings.deliveryZones.length
      ? settings.deliveryZones.find((z) => z.id === input.zoneId)
      : undefined;
    if (settings.deliveryZones.length && (!input.zoneId || !zone))
      throw AppError.validation([{ path: 'zoneId', message: 'Choose a delivery area' }]);
    const zoneChargeMinor = zone?.chargeMinor ?? 0;
    // A coupon is checked again here (it may have ended or been used up since Apply).
    let coupon: AppliedCoupon | undefined;
    if (input.couponCode?.trim()) {
      await guardCouponTry(this.redis, this.limits, org._id.toHexString(), input.couponCode);
      coupon = await this.coupons.prepare(
        input.couponCode,
        { type: 'landing', pageId: page._id.toHexString() },
        { goodsMinor, deliveryChargeMinor: zoneChargeMinor },
        phone,
      );
    }
    const deliveryChargeMinor = coupon?.freeDelivery ? 0 : zoneChargeMinor;
    const plan = this.shopPayments.plan(
      input.payment,
      await this.shopPayments.options({
        totalMinor: goodsMinor - (coupon?.discountMinor ?? 0) + deliveryChargeMinor,
        deliveryChargeMinor,
        zoneId: zone?.id ?? null,
        currency: org.currency,
      }),
    );

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
        payment: { method: plan.method, ...(plan.online ? { online: plan.online } : {}) },
        ...(note ? { customerNote: note } : {}),
        status: 'pending',
        source: 'landing_page',
        customerSource: 'store',
        storeId: store._id.toHexString(),
        landingPage: {
          id: page._id.toHexString(),
          name: page.name,
          slug: page.slug,
          ...(l.ab ? { abTest: { id: l.ab.testId, variant: l.ab.variant } } : {}),
        },
        ...(input.attribution && Object.keys(input.attribution).length
          ? { attribution: input.attribution }
          : {}),
        ...(coupon ? { coupon } : {}),
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
    if (l.ab) await this.abTests.countOrder(l.ab, order.totalMinor);
    await this.storefront.closeCart(input.cartToken, order);
    await this.adEvents.orderPlaced(
      order,
      { type: 'landing', id: page._id.toHexString() },
      { ...input.tracking, fbclid: input.attribution?.fbclid, ttclid: input.attribution?.ttclid },
    );
    let payment: PaymentStart | null = null;
    if (plan.online) {
      const receipt = this.links.receiptToken(store._id.toHexString(), order._id.toHexString());
      payment = await this.storefront.startPayment(
        l.store,
        order,
        plan.online.gateway,
        this.thanksUrl(l, receipt),
      );
    }
    return this.placed(l, order, false, payment);
  }

  /**
   * What a coupon code takes off the shopper's current choice (ADR 0031), with the totals
   * the form shows. Only on live pages; never changes anything.
   */
  async couponCheck(l: ResolvedLanding, input: LandingCouponInput) {
    if (l.state !== 'live')
      throw AppError.conflict('offer_not_available', 'This offer is not available right now.');
    return this.inPage(l, async () => {
      const { org } = l.store;
      await guardCouponTry(this.redis, this.limits, org._id.toHexString(), input.code);
      const { goodsMinor } = await this.priceSelection(l, input);
      const settings = await this.shopSettings.get();
      const zone = settings.deliveryZones.find((z) => z.id === input.zoneId);
      const zoneChargeMinor = zone?.chargeMinor ?? 0;
      let phone: string | undefined;
      if (input.phone?.trim()) {
        try {
          phone = (await this.customers.normalizePhones({ phone: input.phone }, 'phone.')).phone;
        } catch {
          // A half-typed number: the per-customer limit is checked when the order is placed.
        }
      }
      const result = await this.coupons.check(
        input.code,
        { type: 'landing', pageId: l.page._id.toHexString() },
        { goodsMinor, deliveryChargeMinor: zoneChargeMinor },
        phone,
      );
      const off = result.valid ? result.discountMinor : 0;
      const delivery = result.valid && result.freeDelivery ? 0 : zoneChargeMinor;
      return {
        coupon: result,
        goodsMinor,
        discountMinor: off,
        deliveryChargeMinor: delivery,
        totalMinor: goodsMinor - off + delivery,
        currency: org.currency,
      };
    });
  }

  /**
   * Prices the shopper's choice from the published offer and the catalog as they are now:
   * the order lines, the package saving as a discount, and the goods total. Throws what the
   * shopper should be told when the choice cannot be bought.
   */
  private async priceSelection(l: ResolvedLanding, input: LandingSelection) {
    const { org } = l.store;
    const { offer } = l.content!;
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
    let goodsMinor = main.totalMinor;

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
      goodsMinor += charge.totalMinor;
    }
    return { items, discountMinor, goodsMinor, packageLabel };
  }

  /** The page's thank-you address for an order (where gateways send the shopper back). */
  thanksUrl(l: ResolvedLanding, receipt: string): string {
    return `${this.links.url(l.store.store).replace(/\/$/, '')}/${l.page.slug}/thanks?receipt=${encodeURIComponent(receipt)}`;
  }

  /** "Pay now" on the thank-you page: like the store's, back to this page's thank-you. */
  pay(l: ResolvedLanding, receipt: string, gateway: ShopGatewayKey): Promise<PaymentStart> {
    return this.inPage(l, () =>
      this.storefront.pay(l.store, receipt, gateway, this.thanksUrl(l, receipt)),
    );
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

  private placed(
    l: ResolvedLanding,
    order: OrderDoc,
    duplicate: boolean,
    payment: PaymentStart | null,
  ) {
    return {
      orderNumber: order.number,
      totalMinor: order.totalMinor,
      currency: order.currency,
      receipt: this.links.receiptToken(l.store.store._id.toHexString(), order._id.toHexString()),
      /** True when this is the receipt of an order the shopper placed a moment ago. */
      duplicate,
      /** The online payment started for the order, if the shopper chose one (ADR 0029). */
      payment,
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
      /** The page's ad tags, so the thank-you page can report the purchase (ADR 0030). */
      tracking: await this.inPage(l, () =>
        this.adDestinations.publicTracking({ type: 'landing', id: l.page._id.toHexString() }),
      ),
    };
  }
}
