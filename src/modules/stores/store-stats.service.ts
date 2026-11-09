import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { sha256 } from '../../common/crypto/tokens.js';
import { dayKey, lastDayKeys } from '../../common/time/zoned.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import type { OrderDoc } from '../commerce/orders.service.js';
import { ProductRepository } from '../commerce/repositories.js';
import type { OrderAttribution } from '../commerce/schemas.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { StoreProductStatRepository, StoreStatRepository } from './repositories.js';
import type { ResolvedStore } from './storefront.service.js';
import { TRAFFIC_SOURCES, trafficSource, type TrafficSource } from './traffic-source.js';

export const STORE_EVENTS = ['visit', 'product_view', 'cart_add', 'checkout'] as const;
export type StoreEventType = (typeof STORE_EVENTS)[number];

export interface StoreEvent {
  type: StoreEventType;
  /** A random id the shopper's browser keeps; without one the shopper's address stands in. */
  visitorId?: string;
  productId?: string;
  /** Where the visit came from (only read for `visit`). */
  attribution?: OrderAttribution;
}

/** A shopper counts once per step and day; the marker outlives the day by a little. */
const EVENT_TTL_S = 2 * 86_400;
const TOP_PRODUCTS = 10;

const STEP_FIELD: Record<Exclude<StoreEventType, 'product_view'>, string> = {
  visit: 'visitors',
  cart_add: 'cartVisitors',
  checkout: 'checkoutVisitors',
};

interface DayRow {
  day: string;
  visitors: number;
  productViewers: number;
  cartVisitors: number;
  checkoutVisitors: number;
  orders: number;
  revenueMinor: number;
}

const ZERO: Omit<DayRow, 'day'> = {
  visitors: 0,
  productViewers: 0,
  cartVisitors: 0,
  checkoutVisitors: 0,
  orders: 0,
  revenueMinor: 0,
};

/**
 * Store visits and sales (ADR 0027): how many shoppers came, how far they got (a product,
 * the cart, the checkout), how many ordered, from where, and which products they looked at
 * and bought. Only counts are kept; no visitor id or address reaches the database.
 */
@Injectable()
export class StoreStatsService {
  private readonly logger = new Logger(StoreStatsService.name);

  constructor(
    private readonly stats: StoreStatRepository,
    private readonly productStats: StoreProductStatRepository,
    private readonly products: ProductRepository,
    private readonly orgs: OrgsService,
    private readonly limits: RateLimitService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ---------------------------------------------------------------- counting (storefront)

  /**
   * Counts one shopper step in an open store, at most once per shopper, step (and product)
   * and day. Previews, closed stores and unknown products count nothing. Runs inside the
   * store's business.
   */
  async record(r: ResolvedStore, e: StoreEvent): Promise<{ counted: boolean }> {
    if (r.state !== 'open') return { counted: false };
    const ip = RequestContext.current()?.ip;
    if (ip) await this.limits.consume('store-event:ip', ip);
    const who = e.visitorId || ip;
    if (!who) return { counted: false };
    const storeId = r.store._id;
    const sid = storeId.toHexString();
    const day = dayKey(new Date(), r.org.timezone);
    const shopper = sha256(who).slice(0, 32);

    if (e.type === 'product_view') {
      if (!e.productId || !Types.ObjectId.isValid(e.productId)) return { counted: false };
      const productId = new Types.ObjectId(e.productId);
      if (!(await this.first(`${sid}:${day}:pv:${productId.toHexString()}:${shopper}`)))
        return { counted: false };
      if (!(await this.products.exists({ _id: productId, status: 'active' })))
        return { counted: false };
      await this.productStats.findOneAndUpdate(
        { storeId, productId, day },
        { $inc: { viewers: 1 } },
        { upsert: true },
      );
      // The store's own step counts the shopper once, whichever products they looked at.
      if (await this.first(`${sid}:${day}:pv:${shopper}`))
        await this.bump(storeId, day, { productViewers: 1 });
      return { counted: true };
    }

    if (!(await this.first(`${sid}:${day}:${e.type}:${shopper}`))) return { counted: false };
    const inc: Record<string, number> = { [STEP_FIELD[e.type]]: 1 };
    if (e.type === 'visit') inc[`sources.${trafficSource(e.attribution)}`] = 1;
    await this.bump(storeId, day, inc);
    return { counted: true };
  }

  /** Adds an order placed in the store. Never fails the order: a miss is only logged. */
  async orderPlaced(
    r: ResolvedStore,
    order: OrderDoc,
    attribution: OrderAttribution | undefined,
  ): Promise<void> {
    try {
      const storeId = r.store._id;
      const day = dayKey(order.placedAt, r.org.timezone);
      await this.bump(storeId, day, {
        orders: 1,
        revenueMinor: order.totalMinor,
        [`orderSources.${trafficSource(attribution)}`]: 1,
      });
      const byProduct = new Map<string, { units: number; revenueMinor: number }>();
      for (const item of order.items) {
        const key = item.productId.toHexString();
        const t = byProduct.get(key) ?? { units: 0, revenueMinor: 0 };
        t.units += item.quantity;
        t.revenueMinor += item.unitPriceMinor * item.quantity;
        byProduct.set(key, t);
      }
      for (const [productId, t] of byProduct)
        await this.productStats.findOneAndUpdate(
          { storeId, productId: new Types.ObjectId(productId), day },
          { $inc: { orders: 1, units: t.units, revenueMinor: t.revenueMinor } },
          { upsert: true },
        );
    } catch (err) {
      this.logger.error(
        { err, orderId: order._id.toHexString() },
        'Could not count a store order in its numbers',
      );
    }
  }

  private async first(key: string): Promise<boolean> {
    return (await this.redis.set(`st:ev:${key}`, '1', 'EX', EVENT_TTL_S, 'NX')) === 'OK';
  }

  private async bump(storeId: Types.ObjectId, day: string, inc: Record<string, number>) {
    await this.stats.findOneAndUpdate({ storeId, day }, { $inc: inc }, { upsert: true });
  }

  // ---------------------------------------------------------------- reading (dashboard)

  /**
   * The store's numbers over the last `days` days (oldest first, every day filled in), the
   * same length of time before it for comparison, the steps shoppers got to, where they
   * came from, and the products looked at most.
   */
  async summary(storeId: Types.ObjectId, days: number) {
    const orgId = RequestContext.tenant()!.orgId;
    const org = await this.orgs.get(orgId);
    const keys = lastDayKeys(days * 2, org.timezone);
    const prevKeys = new Set(keys.slice(0, days));
    const shown = keys.slice(days);
    const rows = await this.stats.find({ storeId, day: { $gte: keys[0]! } });

    const byDay = new Map(rows.map((r) => [r.day, r]));
    const daily: DayRow[] = shown.map((day) => {
      const r = byDay.get(day);
      return {
        day,
        visitors: r?.visitors ?? 0,
        productViewers: r?.productViewers ?? 0,
        cartVisitors: r?.cartVisitors ?? 0,
        checkoutVisitors: r?.checkoutVisitors ?? 0,
        orders: r?.orders ?? 0,
        revenueMinor: r?.revenueMinor ?? 0,
      };
    });
    const total = daily.reduce((a, d) => add(a, d), { ...ZERO });
    const previous = rows
      .filter((r) => prevKeys.has(r.day))
      .reduce((a, d) => add(a, d), { ...ZERO });

    const sourceVisitors = new Map<TrafficSource, number>();
    const sourceOrders = new Map<TrafficSource, number>();
    for (const r of rows) {
      if (prevKeys.has(r.day)) continue;
      for (const s of TRAFFIC_SOURCES) {
        sourceVisitors.set(s, (sourceVisitors.get(s) ?? 0) + (r.sources?.[s] ?? 0));
        sourceOrders.set(s, (sourceOrders.get(s) ?? 0) + (r.orderSources?.[s] ?? 0));
      }
    }
    const sources = TRAFFIC_SOURCES.map((source) => ({
      source,
      visitors: sourceVisitors.get(source) ?? 0,
      orders: sourceOrders.get(source) ?? 0,
    }))
      .filter((s) => s.visitors > 0 || s.orders > 0)
      .sort((a, b) => b.visitors - a.visitors || b.orders - a.orders);

    return {
      days: daily,
      total,
      previous,
      conversionRate: total.visitors ? total.orders / total.visitors : null,
      funnel: [
        { step: 'visited', shoppers: total.visitors },
        { step: 'viewed_product', shoppers: total.productViewers },
        { step: 'added_to_cart', shoppers: total.cartVisitors },
        { step: 'started_checkout', shoppers: total.checkoutVisitors },
        { step: 'ordered', shoppers: total.orders },
      ],
      sources,
      products: await this.topProducts(storeId, shown[0]!),
      currency: org.currency,
    };
  }

  private async topProducts(storeId: Types.ObjectId, since: string) {
    const rows = await this.productStats.aggregate<{
      _id: Types.ObjectId;
      viewers: number;
      orders: number;
      units: number;
      revenueMinor: number;
    }>([
      { $match: { storeId, day: { $gte: since } } },
      {
        $group: {
          _id: '$productId',
          viewers: { $sum: '$viewers' },
          orders: { $sum: '$orders' },
          units: { $sum: '$units' },
          revenueMinor: { $sum: '$revenueMinor' },
        },
      },
      { $sort: { viewers: -1, orders: -1, _id: 1 } },
      { $limit: TOP_PRODUCTS },
    ]);
    if (rows.length === 0) return [];
    const found = await this.products.find(
      { _id: { $in: rows.map((r) => r._id) } },
      { name: 1, slug: 1 },
    );
    const names = new Map(found.map((p) => [p._id.toHexString(), p]));
    return rows.map((r) => {
      const p = names.get(r._id.toHexString());
      return {
        productId: r._id.toHexString(),
        name: p?.name ?? null,
        slug: p?.slug ?? null,
        viewers: r.viewers,
        orders: r.orders,
        units: r.units,
        revenueMinor: r.revenueMinor,
        // Orders per shopper who looked: above 1 when people order without the product page.
        conversionRate: r.viewers ? r.orders / r.viewers : null,
      };
    });
  }
}

function add<T extends Omit<DayRow, 'day'>>(a: T, d: Omit<DayRow, 'day'>): T {
  return {
    ...a,
    visitors: a.visitors + (d.visitors ?? 0),
    productViewers: a.productViewers + (d.productViewers ?? 0),
    cartVisitors: a.cartVisitors + (d.cartVisitors ?? 0),
    checkoutVisitors: a.checkoutVisitors + (d.checkoutVisitors ?? 0),
    orders: a.orders + (d.orders ?? 0),
    revenueMinor: a.revenueMinor + (d.revenueMinor ?? 0),
  };
}
