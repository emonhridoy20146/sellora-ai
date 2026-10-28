import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError, type FieldError } from '../../common/errors/app-error.js';
import { startOfDayInZone, startOfMonthInZone } from '../../common/time/zoned.js';
import { CounterService } from '../../infra/database/counter.service.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { CustomersService } from './customers.service.js';
import { InventoryService, type StockLine } from './inventory.service.js';
import { OrderRepository, ProductRepository } from './repositories.js';
import type {
  Address,
  CustomerSource,
  Order,
  OrderItem,
  OrderPaymentStatus,
  OrderSource,
  OrderStatus,
  PaymentMethod,
  ShopSettings,
} from './schemas.js';
import { ShopSettingsService } from './shop-settings.service.js';
import { escapeRegex } from './text.js';

export type OrderDoc = WithId<Order>;

export interface OrderItemInput {
  productId: string;
  variantId: string;
  quantity: number;
  /** Overrides the catalog price (a negotiated price). */
  unitPriceMinor?: number;
}

export interface CreateOrderInput {
  customer: { id?: string; name: string; phone?: string; email?: string };
  shippingAddress: Address;
  items: OrderItemInput[];
  /** null means no delivery zone; leaving it out uses the default zone. */
  deliveryZoneId?: string | null;
  /** Overrides the zone's charge. */
  deliveryChargeMinor?: number;
  discountMinor?: number;
  payment?: { method: PaymentMethod; paidMinor?: number; reference?: string };
  customerNote?: string;
  internalNote?: string;
  /** Defaults to the shop setting (confirmed when auto-confirm is on). */
  status?: 'pending' | 'confirmed';
  source?: OrderSource;
  /** Where a new customer came from (the inbox channel, for example). */
  customerSource?: CustomerSource;
  /** Place the order even though the customer is blocked. */
  allowBlockedCustomer?: boolean;
  /** The inbox conversation the order was taken in. */
  conversationId?: string;
}

/** Allowed moves between statuses. Cancelling and returning are terminal. */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'shipped', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

/** Statuses in which the items, discount and delivery charge can still change. */
const EDITABLE: readonly OrderStatus[] = ['pending', 'confirmed', 'packed'];
/** Statuses in which the order holds stock. */
const HOLDS_STOCK: readonly OrderStatus[] = ['confirmed', 'packed', 'shipped', 'delivered'];

export function toOrderDto(o: OrderDoc) {
  return {
    id: o._id.toHexString(),
    number: o.number,
    status: o.status,
    source: o.source,
    customerId: o.customerId.toHexString(),
    customer: {
      name: o.customer.name,
      phone: o.customer.phone ?? null,
      email: o.customer.email ?? null,
    },
    shippingAddress: o.shippingAddress,
    items: o.items.map((i) => ({
      productId: i.productId.toHexString(),
      variantId: i.variantId.toHexString(),
      name: i.name,
      variantTitle: i.variantTitle,
      sku: i.sku ?? null,
      imageUrl: i.imageUrl ?? null,
      unitPriceMinor: i.unitPriceMinor,
      unitCostMinor: i.unitCostMinor ?? null,
      quantity: i.quantity,
      totalMinor: i.totalMinor,
      trackStock: i.trackStock,
    })),
    currency: o.currency,
    subtotalMinor: o.subtotalMinor,
    discountMinor: o.discountMinor,
    deliveryChargeMinor: o.deliveryChargeMinor,
    totalMinor: o.totalMinor,
    dueMinor: o.payment.status === 'refunded' ? 0 : Math.max(0, o.totalMinor - o.payment.paidMinor),
    /** Paid more than the order now costs (items were removed): money owed back. */
    refundDueMinor:
      o.payment.status === 'refunded' ? 0 : Math.max(0, o.payment.paidMinor - o.totalMinor),
    deliveryZone: o.deliveryZone ?? null,
    payment: {
      method: o.payment.method,
      status: o.payment.status,
      paidMinor: o.payment.paidMinor,
      reference: o.payment.reference ?? null,
    },
    stockCommitted: o.stockCommitted,
    conversationId: o.conversationId?.toHexString() ?? null,
    customerNote: o.customerNote,
    internalNote: o.internalNote,
    cancelReason: o.cancelReason ?? null,
    history: o.history.map((h) => ({
      status: h.status,
      at: h.at.toISOString(),
      actor: h.actor,
      note: h.note ?? null,
    })),
    allowedTransitions: ORDER_TRANSITIONS[o.status],
    editable: EDITABLE.includes(o.status),
    placedAt: o.placedAt.toISOString(),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

function paymentStatus(paidMinor: number, totalMinor: number): OrderPaymentStatus {
  if (paidMinor <= 0) return 'unpaid';
  return paidMinor >= totalMinor ? 'paid' : 'partial';
}

function stockLines(items: OrderItem[]): StockLine[] {
  return items
    .filter((i) => i.trackStock)
    .map((i) => ({ productId: i.productId, variantId: i.variantId, quantity: i.quantity }));
}

/** Quantity per variant across lines. */
function quantities(lines: StockLine[]): Map<string, StockLine> {
  const map = new Map<string, StockLine>();
  for (const l of lines) {
    const key = String(l.variantId);
    const prev = map.get(key);
    map.set(key, prev ? { ...prev, quantity: prev.quantity + l.quantity } : { ...l });
  }
  return map;
}

/**
 * Manual orders and the order lifecycle. Stock is taken when an order is confirmed and put
 * back when it is cancelled or returned; every step runs in a transaction with a guard on
 * the current status, so two people pressing the same button cannot double-count stock.
 */
export interface OrdersSummary {
  currency: string;
  timezone: string;
  today: { orders: number; valueMinor: number };
  month: { orders: number; valueMinor: number };
  toHandle: { pending: number; confirmed: number; packed: number };
  /** Shipped orders and what couriers still have to collect on them. */
  shipped: { orders: number; toCollectMinor: number };
  products: { active: number; lowStock: number };
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly products: ProductRepository,
    private readonly customers: CustomersService,
    private readonly inventory: InventoryService,
    private readonly shopSettings: ShopSettingsService,
    private readonly entitlements: EntitlementsService,
    private readonly orgs: OrgsService,
    private readonly counters: CounterService,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private actor() {
    const a = RequestContext.actor();
    return { type: a.type, id: a.id };
  }

  // ---------------------------------------------------------------- reads

  async list(query: {
    q?: string;
    status?: OrderStatus;
    paymentStatus?: OrderPaymentStatus;
    customerId?: string;
    from?: Date;
    to?: Date;
    limit: number;
    cursor?: string;
  }) {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.paymentStatus) filter['payment.status'] = query.paymentStatus;
    if (query.customerId) filter.customerId = new Types.ObjectId(query.customerId);
    if (query.from || query.to)
      filter.placedAt = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lt: query.to } : {}),
      };
    const q = query.q?.trim();
    if (q) {
      const rx = escapeRegex(q);
      const digits = q.replace(/\D/g, '');
      const or: Record<string, unknown>[] = [
        { number: { $regex: rx, $options: 'i' } },
        { 'customer.name': { $regex: rx, $options: 'i' } },
      ];
      // "01712 345678" and "+8801712345678" should both find the stored E.164 number.
      if (digits.length >= 4)
        or.push({ 'customer.phone': { $regex: escapeRegex(digits.replace(/^0/, '')) } });
      filter.$or = or;
    }
    return this.orders.paginate(filter, query, 'placedAt');
  }

  async statusCounts(): Promise<Record<OrderStatus | 'all', number>> {
    const rows = await this.orders.aggregate<{ _id: OrderStatus; n: number }>([
      { $match: {} },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    const counts = {
      all: 0,
      pending: 0,
      confirmed: 0,
      packed: 0,
      shipped: 0,
      delivered: 0,
      cancelled: 0,
      returned: 0,
    };
    for (const r of rows) {
      counts[r._id] = r.n;
      counts.all += r.n;
    }
    return counts;
  }

  /**
   * Numbers for the overview page. "Order value" counts orders that are not cancelled or
   * returned, by the day and month they were placed in the business's time zone.
   */
  async summary(): Promise<OrdersSummary> {
    const [org, settings] = await Promise.all([
      this.orgs.get(this.orgId()),
      this.shopSettings.get(),
    ]);
    const now = new Date();
    const counted = { status: { $nin: ['cancelled', 'returned'] }, currency: org.currency };
    const totals = [
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          valueMinor: { $sum: '$totalMinor' },
        },
      },
    ];
    type Total = { orders: number; valueMinor: number };
    const [row] = await this.orders.aggregate<{ today: Total[]; month: Total[] }>([
      { $match: { placedAt: { $gte: startOfMonthInZone(now, org.timezone) } } },
      {
        $facet: {
          today: [
            { $match: { ...counted, placedAt: { $gte: startOfDayInZone(now, org.timezone) } } },
            ...totals,
          ],
          month: [{ $match: counted }, ...totals],
        },
      },
    ]);
    // Open and shipped orders are not limited to this month, so they get their own query.
    const [open] = await this.orders.aggregate<{
      open: { _id: OrderStatus; n: number }[];
      shipped: { orders: number; dueMinor: number }[];
    }>([
      { $match: { status: { $in: ['pending', 'confirmed', 'packed', 'shipped'] } } },
      {
        $facet: {
          open: [
            { $match: { status: { $in: ['pending', 'confirmed', 'packed'] } } },
            { $group: { _id: '$status', n: { $sum: 1 } } },
          ],
          shipped: [
            { $match: { status: 'shipped', currency: org.currency } },
            {
              $group: {
                _id: null,
                orders: { $sum: 1 },
                dueMinor: {
                  $sum: { $max: [0, { $subtract: ['$totalMinor', '$payment.paidMinor'] }] },
                },
              },
            },
          ],
        },
      },
    ]);
    const openCount = (status: OrderStatus) => open?.open.find((r) => r._id === status)?.n ?? 0;
    const [activeProducts, lowStockProducts] = await Promise.all([
      this.products.count({ status: 'active' }),
      this.products.count({
        status: { $ne: 'archived' },
        variants: {
          $elemMatch: { trackStock: true, stock: { $lte: settings.lowStockThreshold } },
        },
      }),
    ]);
    return {
      currency: org.currency,
      timezone: org.timezone,
      today: { orders: row?.today[0]?.orders ?? 0, valueMinor: row?.today[0]?.valueMinor ?? 0 },
      month: { orders: row?.month[0]?.orders ?? 0, valueMinor: row?.month[0]?.valueMinor ?? 0 },
      toHandle: {
        pending: openCount('pending'),
        confirmed: openCount('confirmed'),
        packed: openCount('packed'),
      },
      shipped: {
        orders: open?.shipped[0]?.orders ?? 0,
        toCollectMinor: open?.shipped[0]?.dueMinor ?? 0,
      },
      products: { active: activeProducts, lowStock: lowStockProducts },
    };
  }

  async get(id: string): Promise<OrderDoc> {
    const o = await this.orders.findById(id);
    if (!o) throw AppError.notFound('order');
    return o;
  }

  /** A customer's latest orders (the AI agent tells customers about their own orders). */
  async recentForCustomer(customerId: Types.ObjectId, limit: number): Promise<OrderDoc[]> {
    return this.orders.find({ customerId }, { sort: { placedAt: -1 }, limit });
  }

  /** Orders taken in an inbox conversation since `since`, newest first. */
  async recentForConversation(conversationId: Types.ObjectId, since: Date): Promise<OrderDoc[]> {
    return this.orders.find(
      { conversationId, placedAt: { $gte: since } },
      { sort: { placedAt: -1 }, limit: 10 },
    );
  }

  /** Several orders for printing, in the order asked for. */
  async getMany(ids: string[]): Promise<OrderDoc[]> {
    const valid = [...new Set(ids)].filter((i) => Types.ObjectId.isValid(i));
    const docs = await this.orders.find({ _id: { $in: valid.map((i) => new Types.ObjectId(i)) } });
    const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
    return valid.map((i) => byId.get(i)).filter((d): d is OrderDoc => Boolean(d));
  }

  // ---------------------------------------------------------------- pricing

  /**
   * Builds order lines from the catalog. Items already on the order keep the price the
   * customer agreed to unless a new price is given, and may stay even if the product has
   * been archived since.
   */
  private async priceItems(
    inputs: OrderItemInput[],
    currency: string,
    existing: OrderItem[] = [],
  ): Promise<OrderItem[]> {
    const errors: FieldError[] = [];
    const seen = new Set<string>();
    inputs.forEach((i, n) => {
      if (seen.has(i.variantId))
        errors.push({ path: `items.${n}.variantId`, message: 'This item is listed twice' });
      seen.add(i.variantId);
    });
    if (errors.length) throw AppError.validation(errors);

    const ids = [...new Set(inputs.map((i) => i.productId))].map((i) => new Types.ObjectId(i));
    const products = await this.products.find({ _id: { $in: ids } });
    const byId = new Map(products.map((p) => [p._id.toHexString(), p]));

    const items: OrderItem[] = [];
    inputs.forEach((input, n) => {
      const product = byId.get(input.productId);
      const variant = product?.variants.find((v) => v._id.toHexString() === input.variantId);
      const previous = existing.find((e) => e.variantId.toHexString() === input.variantId);
      if (!product || !variant) {
        errors.push({ path: `items.${n}`, message: 'This product or variant no longer exists' });
        return;
      }
      if (product.status === 'archived' && !previous) {
        errors.push({ path: `items.${n}`, message: `${product.name} is no longer for sale` });
        return;
      }
      if (product.currency !== currency) {
        errors.push({
          path: `items.${n}`,
          message: `${product.name} is priced in ${product.currency}, the order is in ${currency}`,
        });
        return;
      }
      const unit = input.unitPriceMinor ?? previous?.unitPriceMinor ?? variant.priceMinor;
      const total = unit * input.quantity;
      if (!Number.isSafeInteger(total)) {
        errors.push({ path: `items.${n}.quantity`, message: 'The amount is too large' });
        return;
      }
      items.push({
        productId: product._id,
        variantId: variant._id,
        name: product.name,
        variantTitle: variant.title === 'Default' ? '' : variant.title,
        ...(variant.sku ? { sku: variant.sku } : {}),
        ...(product.images[0] ? { imageUrl: product.images[0].url } : {}),
        unitPriceMinor: unit,
        ...(variant.costMinor !== undefined ? { unitCostMinor: variant.costMinor } : {}),
        quantity: input.quantity,
        totalMinor: total,
        trackStock: variant.trackStock,
      });
    });
    if (errors.length) throw AppError.validation(errors);
    return items;
  }

  private resolveZone(
    settings: ShopSettings,
    zoneId: string | null | undefined,
  ): { id: string; name: string; chargeMinor: number } | undefined {
    const id = zoneId === undefined ? settings.defaultZoneId : zoneId;
    if (!id) return undefined;
    const zone = settings.deliveryZones.find((z) => z.id === id);
    if (!zone) {
      if (zoneId === undefined) return undefined; // stale default
      throw AppError.validation([{ path: 'deliveryZoneId', message: 'Unknown delivery zone' }]);
    }
    return zone;
  }

  private totals(items: OrderItem[], discountMinor: number, deliveryChargeMinor: number) {
    const subtotalMinor = items.reduce((a, i) => a + i.totalMinor, 0);
    if (discountMinor > subtotalMinor)
      throw AppError.validation([
        { path: 'discountMinor', message: 'The discount cannot be more than the item total' },
      ]);
    return {
      subtotalMinor,
      discountMinor,
      deliveryChargeMinor,
      totalMinor: subtotalMinor - discountMinor + deliveryChargeMinor,
    };
  }

  private async monthlyCount(timezone: string): Promise<number> {
    return this.orders.count({ placedAt: { $gte: startOfMonthInZone(new Date(), timezone) } });
  }

  // ---------------------------------------------------------------- stock

  /**
   * Takes the order's tracked items out of stock. Tracking flags are refreshed from the
   * catalog first, so the order records exactly what was taken.
   */
  private async commitStock(order: OrderDoc): Promise<OrderItem[]> {
    const products = await this.products.find(
      {
        _id: {
          $in: [...new Set(order.items.map((i) => i.productId.toHexString()))].map(
            (i) => new Types.ObjectId(i),
          ),
        },
      },
      { projection: { variants: 1 } },
    );
    const items = order.items.map((i) => {
      const variant = products
        .find((p) => p._id.equals(i.productId))
        ?.variants.find((v) => v._id.equals(i.variantId));
      return { ...i, trackStock: variant?.trackStock ?? false };
    });
    await this.inventory.deduct(stockLines(items), 'order', this.reference(order));
    await this.adjustSold(items, 1);
    return items;
  }

  private async releaseStock(order: OrderDoc, reason: 'order_cancel' | 'return'): Promise<void> {
    await this.inventory.restore(stockLines(order.items), reason, this.reference(order));
    await this.adjustSold(order.items, -1);
  }

  private async adjustSold(items: { productId: Types.ObjectId; quantity: number }[], sign: 1 | -1) {
    const perProduct = new Map<string, number>();
    for (const i of items)
      perProduct.set(
        i.productId.toHexString(),
        (perProduct.get(i.productId.toHexString()) ?? 0) + i.quantity,
      );
    for (const [productId, qty] of perProduct)
      if (qty !== 0)
        await this.products.updateOne(
          { _id: new Types.ObjectId(productId) },
          { $inc: { soldCount: sign * qty } },
        );
  }

  private reference(order: { _id: Types.ObjectId; number: string }) {
    return { type: 'order', id: order._id.toHexString(), label: order.number };
  }

  // ---------------------------------------------------------------- writes

  async create(raw: CreateOrderInput): Promise<OrderDoc> {
    const orgId = this.orgId();
    const input: CreateOrderInput = {
      ...raw,
      customer: {
        ...raw.customer,
        ...(await this.customers.normalizePhones({ phone: raw.customer.phone }, 'customer.')),
      },
      shippingAddress: await this.customers.normalizeAddress(
        raw.shippingAddress,
        'shippingAddress',
      ),
    };
    const [org, settings] = await Promise.all([this.orgs.get(orgId), this.shopSettings.get()]);
    await this.entitlements.assertWithinLimit(
      orgId,
      'ordersPerMonth',
      await this.monthlyCount(org.timezone),
    );

    const items = await this.priceItems(input.items, org.currency);
    const zone = this.resolveZone(settings, input.deliveryZoneId);
    const totals = this.totals(
      items,
      input.discountMinor ?? 0,
      input.deliveryChargeMinor ?? zone?.chargeMinor ?? 0,
    );
    const paidMinor = input.payment?.paidMinor ?? 0;
    if (paidMinor > totals.totalMinor)
      throw AppError.validation([
        { path: 'payment.paidMinor', message: 'The paid amount is more than the order total' },
      ]);

    const source = input.source ?? 'manual';
    const customer = await this.customers.resolveForOrder({
      ...(input.customer.id ? { customerId: input.customer.id } : {}),
      name: input.customer.name,
      ...(input.customer.phone ? { phone: input.customer.phone } : {}),
      ...(input.customer.email ? { email: input.customer.email } : {}),
      address: input.shippingAddress,
      source:
        input.customerSource ??
        (source === 'store' || source === 'landing_page' ? 'store' : 'manual'),
    });
    if (customer.blocked && !input.allowBlockedCustomer)
      throw AppError.conflict(
        'customer_blocked',
        `${customer.name} is blocked. Unblock them or confirm to place the order anyway.`,
        { customerId: customer._id.toHexString() },
      );

    const status =
      input.status ??
      (source === 'manual' && settings.autoConfirmManualOrders ? 'confirmed' : 'pending');
    const seq = await this.counters.next(`orders:${orgId}`, 1000);
    const number = `${org.settings?.orderNumberPrefix ?? 'SL'}-${seq}`;
    const now = new Date();
    const actor = this.actor();

    const order = await this.tx.run(async () => {
      const created = await this.orders.create({
        number,
        seq,
        status,
        source,
        customerId: customer._id,
        customer: {
          name: customer.name,
          ...(customer.phone ? { phone: customer.phone } : {}),
          ...(customer.email ? { email: customer.email } : {}),
        },
        shippingAddress: {
          ...input.shippingAddress,
          name: input.shippingAddress.name || input.customer.name,
          ...(input.shippingAddress.phone || customer.phone
            ? { phone: input.shippingAddress.phone || customer.phone }
            : {}),
        },
        items,
        currency: org.currency,
        ...totals,
        ...(zone ? { deliveryZone: { id: zone.id, name: zone.name } } : {}),
        payment: {
          method: input.payment?.method ?? 'cod',
          status: paymentStatus(paidMinor, totals.totalMinor),
          paidMinor,
          ...(input.payment?.reference ? { reference: input.payment.reference } : {}),
        },
        stockCommitted: false,
        customerNote: input.customerNote ?? '',
        internalNote: input.internalNote ?? '',
        history: [{ status, at: now, actor }],
        ...(actor.type === 'user' ? { createdBy: new Types.ObjectId(actor.id) } : {}),
        ...(input.conversationId
          ? { conversationId: new Types.ObjectId(input.conversationId) }
          : {}),
        placedAt: now,
      });
      if (status === 'confirmed') {
        const committed = await this.commitStock(created);
        return (await this.orders.findOneAndUpdate(
          { _id: created._id },
          { $set: { items: committed, stockCommitted: true } },
        ))!;
      }
      return created;
    });

    await this.customers.refreshStats(customer._id);
    await this.audit.record({
      action: 'order.created',
      orgId,
      target: { type: 'order', id: order._id.toHexString(), label: order.number },
      metadata: { status, source, totalMinor: order.totalMinor, items: order.items.length },
    });
    return order;
  }

  /**
   * Moves an order to another status. Confirming takes stock; cancelling puts it back;
   * a return puts it back unless `restock` is false (damaged goods).
   */
  async changeStatus(
    id: string,
    to: OrderStatus,
    opts: { note?: string; reason?: string; restock?: boolean } = {},
  ): Promise<OrderDoc> {
    const before = await this.get(id);
    const assertAllowed = (from: OrderStatus) => {
      if (!ORDER_TRANSITIONS[from].includes(to))
        throw AppError.conflict(
          'invalid_status_change',
          from === to ? `The order is already ${to}.` : `A ${from} order cannot be marked ${to}.`,
          { from, to, allowed: ORDER_TRANSITIONS[from] },
        );
    };
    assertAllowed(before.status);

    const after = await this.tx.run(async () => {
      const order = (await this.orders.findById(before._id))!;
      assertAllowed(order.status);
      const set: Record<string, unknown> = { status: to };
      if (HOLDS_STOCK.includes(to) && !order.stockCommitted) {
        set.items = await this.commitStock(order);
        set.stockCommitted = true;
      }
      if ((to === 'cancelled' || to === 'returned') && order.stockCommitted) {
        if (to === 'cancelled' || opts.restock !== false)
          await this.releaseStock(order, to === 'cancelled' ? 'order_cancel' : 'return');
        else await this.adjustSold(order.items, -1);
        set.stockCommitted = false;
      }
      if (to === 'cancelled' && opts.reason) set.cancelReason = opts.reason;
      const note =
        opts.note ??
        (to === 'cancelled' ? opts.reason : undefined) ??
        (to === 'returned' && opts.restock === false ? 'Not restocked' : undefined);
      const updated = await this.orders.findOneAndUpdate(
        { _id: order._id, status: order.status },
        {
          $set: set,
          $push: {
            history: { status: to, at: new Date(), actor: this.actor(), ...(note ? { note } : {}) },
          },
        },
      );
      if (!updated)
        throw AppError.conflict(
          'order_changed',
          'The order was changed by someone else. Reload it.',
        );
      return updated;
    });

    await this.customers.refreshStats(after.customerId);
    await this.audit.record({
      action: to === 'cancelled' ? 'order.cancelled' : 'order.status_changed',
      orgId: this.orgId(),
      target: { type: 'order', id, label: after.number },
      metadata: {
        from: before.status,
        to,
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(to === 'returned' ? { restocked: opts.restock !== false } : {}),
      },
    });
    return after;
  }

  /**
   * Replaces the items, discount or delivery charge while the order has not shipped. When
   * the order holds stock, only the difference per variant is taken or put back.
   */
  async updateItems(
    id: string,
    input: {
      items: OrderItemInput[];
      discountMinor?: number;
      deliveryZoneId?: string | null;
      deliveryChargeMinor?: number;
    },
  ): Promise<OrderDoc> {
    const before = await this.get(id);
    if (!EDITABLE.includes(before.status))
      throw AppError.conflict('order_not_editable', `A ${before.status} order cannot be edited.`);
    const settings = await this.shopSettings.get();

    const after = await this.tx.run(async () => {
      const order = (await this.orders.findById(before._id))!;
      if (!EDITABLE.includes(order.status))
        throw AppError.conflict('order_not_editable', `A ${order.status} order cannot be edited.`);
      const items = await this.priceItems(input.items, order.currency, order.items);

      let zone = order.deliveryZone;
      let delivery = order.deliveryChargeMinor;
      if (input.deliveryZoneId !== undefined) {
        const z = this.resolveZone(settings, input.deliveryZoneId);
        zone = z ? { id: z.id, name: z.name } : undefined;
        delivery = z?.chargeMinor ?? 0;
      }
      if (input.deliveryChargeMinor !== undefined) delivery = input.deliveryChargeMinor;
      const totals = this.totals(items, input.discountMinor ?? order.discountMinor, delivery);

      if (order.stockCommitted) {
        const oldQty = quantities(stockLines(order.items));
        const newQty = quantities(stockLines(items));
        const take: StockLine[] = [];
        const giveBack: StockLine[] = [];
        for (const key of new Set([...oldQty.keys(), ...newQty.keys()])) {
          const delta = (newQty.get(key)?.quantity ?? 0) - (oldQty.get(key)?.quantity ?? 0);
          const line = (newQty.get(key) ?? oldQty.get(key))!;
          if (delta > 0) take.push({ ...line, quantity: delta });
          if (delta < 0) giveBack.push({ ...line, quantity: -delta });
        }
        if (giveBack.length)
          await this.inventory.restore(giveBack, 'order_edit', this.reference(order));
        if (take.length) await this.inventory.deduct(take, 'order_edit', this.reference(order));
        await this.adjustSold(order.items, -1);
        await this.adjustSold(items, 1);
      }

      const set: Record<string, unknown> = {
        items,
        ...totals,
        'payment.status':
          order.payment.status === 'refunded'
            ? 'refunded'
            : paymentStatus(order.payment.paidMinor, totals.totalMinor),
      };
      if (zone) set.deliveryZone = { id: zone.id, name: zone.name };
      const updated = await this.orders.findOneAndUpdate(
        { _id: order._id, status: order.status },
        {
          $set: set,
          ...(zone ? {} : { $unset: { deliveryZone: '' } }),
          $push: {
            history: {
              status: order.status,
              at: new Date(),
              actor: this.actor(),
              note: 'Items changed',
            },
          },
        },
      );
      if (!updated)
        throw AppError.conflict(
          'order_changed',
          'The order was changed by someone else. Reload it.',
        );
      return updated;
    });

    await this.customers.refreshStats(after.customerId);
    await this.audit.record({
      action: 'order.items_updated',
      orgId: this.orgId(),
      target: { type: 'order', id, label: after.number },
      metadata: { totalBefore: before.totalMinor, totalAfter: after.totalMinor },
    });
    return after;
  }

  /** Address and notes. The address is fixed once the parcel has shipped. */
  async updateDetails(
    id: string,
    input: { shippingAddress?: Address; customerNote?: string; internalNote?: string },
  ): Promise<OrderDoc> {
    const before = await this.get(id);
    const set: Record<string, unknown> = {};
    if (input.shippingAddress) {
      if (!EDITABLE.includes(before.status))
        throw AppError.conflict(
          'order_not_editable',
          'The delivery address cannot change after the order has shipped.',
        );
      set.shippingAddress = await this.customers.normalizeAddress(
        input.shippingAddress,
        'shippingAddress',
      );
    }
    if (input.customerNote !== undefined) set.customerNote = input.customerNote;
    if (input.internalNote !== undefined) set.internalNote = input.internalNote;
    if (!Object.keys(set).length) return before;
    const after = (await this.orders.findOneAndUpdate({ _id: before._id }, { $set: set }))!;
    await this.audit.record({
      action: 'order.updated',
      orgId: this.orgId(),
      target: { type: 'order', id, label: after.number },
      metadata: { fields: Object.keys(set) },
    });
    return after;
  }

  /** Records what the customer has paid (or that the money was refunded). */
  async updatePayment(
    id: string,
    input: {
      method?: PaymentMethod;
      paidMinor?: number;
      reference?: string | null;
      refunded?: boolean;
    },
  ): Promise<OrderDoc> {
    const before = await this.get(id);
    const paidMinor = input.paidMinor ?? before.payment.paidMinor;
    // An earlier overpayment (items removed after paying) may stay while other fields change.
    if (input.paidMinor !== undefined && paidMinor > before.totalMinor)
      throw AppError.validation([
        { path: 'paidMinor', message: 'The paid amount is more than the order total' },
      ]);
    const refunded = input.refunded ?? before.payment.status === 'refunded';
    if (refunded && paidMinor <= 0)
      throw AppError.validation([
        { path: 'refunded', message: 'Only a paid amount can be marked as refunded' },
      ]);
    const set: Record<string, unknown> = {
      'payment.paidMinor': paidMinor,
      'payment.status': refunded ? 'refunded' : paymentStatus(paidMinor, before.totalMinor),
    };
    const unset: Record<string, ''> = {};
    if (input.method) set['payment.method'] = input.method;
    if (input.reference !== undefined) {
      if (input.reference) set['payment.reference'] = input.reference;
      else unset['payment.reference'] = '';
    }
    const after = (await this.orders.findOneAndUpdate(
      { _id: before._id },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    ))!;
    await this.audit.record({
      action: 'order.payment_updated',
      orgId: this.orgId(),
      target: { type: 'order', id, label: after.number },
      metadata: {
        before: {
          status: before.payment.status,
          paidMinor: before.payment.paidMinor,
          method: before.payment.method,
        },
        after: {
          status: after.payment.status,
          paidMinor: after.payment.paidMinor,
          method: after.payment.method,
        },
      },
    });
    return after;
  }
}
