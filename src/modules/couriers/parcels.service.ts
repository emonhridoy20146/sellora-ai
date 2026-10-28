import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { nationalDigits, normalizePhone } from '../../common/validation/schemas.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { AuditService } from '../audit/audit.service.js';
import {
  BOOKABLE_ORDER_STATUSES,
  OrdersService,
  type OrderDoc,
} from '../commerce/orders.service.js';
import { ProductsService } from '../commerce/products.service.js';
import type { ShipmentStatus } from '../commerce/schemas.js';
import { CourierAccountsService, type CourierAccountDoc } from './courier-accounts.service.js';
import {
  CourierError,
  type BookingRequest,
  type BookingResult,
  type CourierProvider,
  type ParcelLocation,
} from './courier.types.js';
import { ParcelRepository } from './repositories.js';
import {
  TRACKED_STATUSES,
  type Parcel,
  type ParcelEvent,
  type ParcelEventSource,
} from './schemas.js';

export type ParcelDoc = WithId<Parcel>;

export const COURIER_SEND_JOB = 'send';
export const COURIER_CHECK_JOB = 'check';
export const COURIER_DUE_JOB = 'due';

/** Emitted when a courier first reports a parcel delivered (fully or partly) or returned. */
export const PARCEL_OUTCOME = 'parcel.outcome';

export interface ParcelOutcomeEvent {
  orgId: string;
  parcelId: string;
  /** The recipient's number in E.164. */
  phone: string;
  outcome: 'delivered' | 'returned';
}

export interface CourierJob {
  orgId: string;
  parcelId: string;
  source?: ParcelEventSource;
}

export interface BookingInput {
  accountId?: string;
  codMinor?: number;
  weightGrams?: number;
  note?: string;
  location?: ParcelLocation;
}

/** Orders in these statuses can be handed to a courier. */
const BOOKABLE = BOOKABLE_ORDER_STATUSES;
/** Parcel statuses that mean the courier has (or had) the parcel in hand. */
const PICKED_UP: readonly ShipmentStatus[] = [
  'picked_up',
  'in_transit',
  'on_hold',
  'returning',
  'delivered',
  'partly_delivered',
  'returned',
];
const MOBILE_BD = /^01[3-9]\d{8}$/;
const HOUR = 3_600_000;
/** How often tracking asks the courier, by status. */
const CHECK_EVERY: Partial<Record<ShipmentStatus, number>> = {
  booked: HOUR,
  picked_up: HOUR,
  in_transit: HOUR,
  returning: 2 * HOUR,
  on_hold: 3 * HOUR,
};
/** After a lost reply, how soon to ask the courier whether the booking exists. */
const LOST_CHECKS_MS = [2, 5, 10, 20, 30].map((m) => m * 60_000);
const GIVE_UP_AFTER_MS = 45 * 24 * HOUR;
const MAX_EVENTS = 100;
const MAX_ATTEMPTS = 20;

const isFinal = (s: ShipmentStatus) =>
  !TRACKED_STATUSES.includes(s) && s !== 'queued' && s !== 'sending';

/**
 * Parcels: booking orders with couriers, and following them until they are delivered or
 * come back. A booking is written down before the courier is called, so a crash or a lost
 * reply never leads to a second parcel for the same order. Status changes always come from
 * the courier's API; webhooks only make Sellora ask sooner.
 */
@Injectable()
export class ParcelsService {
  private readonly logger = new Logger(ParcelsService.name);

  constructor(
    private readonly parcels: ParcelRepository,
    @InjectModel('Parcel') private readonly parcelModel: Model<Parcel>,
    private readonly accounts: CourierAccountsService,
    private readonly orders: OrdersService,
    private readonly products: ProductsService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUES.couriers) private readonly queue: Queue<CourierJob>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly events: EventEmitter2,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private actor() {
    const a = RequestContext.actor();
    return { type: a.type, id: a.id };
  }

  // ---------------------------------------------------------------- reads

  async get(id: string): Promise<ParcelDoc> {
    const p = await this.parcels.findById(id);
    if (!p) throw AppError.notFound('parcel');
    return p;
  }

  async forOrder(orderId: string): Promise<ParcelDoc[]> {
    const order = await this.orders.get(orderId);
    return this.parcels.find({ orderId: order._id }, { sort: { createdAt: -1 }, limit: 50 });
  }

  toDto(p: ParcelDoc) {
    const provider = this.accounts.provider(p.provider);
    return {
      id: p._id.toHexString(),
      orderId: p.orderId.toHexString(),
      orderNumber: p.orderNumber,
      accountId: p.accountId.toHexString(),
      provider: p.provider,
      providerName: provider.descriptor.name,
      accountName: p.accountName,
      invoice: p.invoice,
      attempt: p.attempt,
      status: p.status,
      current: p.current,
      providerStatus: p.providerStatus ?? null,
      consignmentId: p.consignmentId ?? null,
      trackingCode: p.trackingCode ?? null,
      trackingUrl:
        p.consignmentId || p.trackingCode
          ? provider.trackingUrl({
              consignmentId: p.consignmentId,
              trackingCode: p.trackingCode,
              phone: p.recipient.phone,
            })
          : null,
      recipient: p.recipient,
      codMinor: p.codMinor,
      valueMinor: p.valueMinor,
      weightGrams: p.weightGrams,
      quantity: p.quantity,
      description: p.description,
      note: p.note ?? null,
      location: p.location ?? null,
      deliveryFeeMinor: p.deliveryFeeMinor ?? null,
      error: p.error ?? null,
      attention: p.attention ?? null,
      events: p.events.map((e) => ({
        at: e.at.toISOString(),
        status: e.status,
        providerStatus: e.providerStatus ?? null,
        source: e.source,
        note: e.note ?? null,
      })),
      bookedAt: p.bookedAt?.toISOString() ?? null,
      lastCheckedAt: p.lastCheckedAt?.toISOString() ?? null,
      nextCheckAt: p.nextCheckAt?.toISOString() ?? null,
      actions: {
        refresh: TRACKED_STATUSES.includes(p.status) || p.status === 'sending',
        cancel: ['queued', 'sending', 'booked'].includes(p.status),
        link: p.status === 'sending',
        dismiss: Boolean(p.attention),
      },
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  summary() {
    return this.orders.shipmentSummary();
  }

  // ---------------------------------------------------------------- booking

  /** Books one order now and answers with the courier's result. */
  async book(orderId: string, input: BookingInput): Promise<ParcelDoc> {
    const order = await this.orders.get(orderId);
    const account = await this.accounts.forBooking(input.accountId);
    const parcel = await this.request(order, account, input);
    return this.send(parcel._id.toHexString());
  }

  /**
   * Books many orders with one account in the background. Orders that cannot go (wrong
   * status, already booked, no mobile number) are skipped with the reason.
   */
  async bookMany(orderIds: string[], input: Omit<BookingInput, 'codMinor' | 'location'>) {
    const account = await this.accounts.forBooking(input.accountId);
    const d = this.accounts.provider(account.provider).descriptor;
    const orders = await this.orders.getMany(orderIds);
    const found = new Set(orders.map((o) => o._id.toHexString()));
    const queued: { orderId: string; number: string; parcelId: string }[] = [];
    const skipped: { orderId: string; number: string | null; reason: string }[] = orderIds
      .filter((id) => !found.has(id))
      .map((id) => ({ orderId: id, number: null, reason: 'Order not found.' }));
    for (const order of orders) {
      try {
        if (d.locationRequired)
          throw AppError.unprocessable(
            'courier_location_required',
            `${d.name} needs a delivery area for each parcel: send this one from the order page.`,
          );
        const parcel = await this.request(order, account, input);
        await this.enqueue(COURIER_SEND_JOB, parcel);
        queued.push({
          orderId: order._id.toHexString(),
          number: order.number,
          parcelId: parcel._id.toHexString(),
        });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        skipped.push({
          orderId: order._id.toHexString(),
          number: order.number,
          reason: err.message,
        });
      }
    }
    if (queued.length)
      await this.audit.record({
        action: 'parcel.bulk_requested',
        orgId: this.orgId(),
        target: { type: 'courier_account', id: account._id.toHexString(), label: account.name },
        metadata: { queued: queued.length, skipped: skipped.length },
      });
    return { accountId: account._id.toHexString(), queued, skipped };
  }

  private async enqueue(
    name: string,
    parcel: Pick<ParcelDoc, '_id' | 'orgId'>,
    source?: ParcelEventSource,
    delay = 0,
  ) {
    const id = parcel._id.toHexString();
    await this.queue.add(
      name,
      { orgId: parcel.orgId.toHexString(), parcelId: id, ...(source ? { source } : {}) },
      {
        // A parcel is sent once. Checks fold together while one is waiting; one more is kept
        // while a check runs, so a webhook that arrives meanwhile is never lost; a finished
        // check never blocks the next one.
        ...(name === COURIER_SEND_JOB
          ? { jobId: `send-${id}` }
          : { deduplication: { id: `check-${id}`, keepLastIfActive: true } }),
        delay,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 3600, count: 2_000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );
  }

  /** Validates the order for the courier and writes the parcel down, before any call. */
  private async request(
    order: OrderDoc,
    account: CourierAccountDoc,
    input: BookingInput,
  ): Promise<ParcelDoc> {
    const provider = this.accounts.provider(account.provider);
    const d = provider.descriptor;
    if (!BOOKABLE.includes(order.status))
      throw AppError.conflict(
        'order_not_ready_for_courier',
        `Only confirmed or packed orders can go to a courier; ${order.number} is ${order.status}.`,
      );
    if (await this.parcels.exists({ orderId: order._id, current: true }))
      throw AppError.conflict('parcel_exists', `${order.number} is already booked with a courier.`);
    if (order.currency !== 'BDT')
      throw AppError.unprocessable(
        'courier_currency',
        `${d.name} collects taka; this order is in ${order.currency}.`,
      );
    if (d.pickupStore === 'required' && !account.settings.storeId)
      throw AppError.unprocessable(
        'courier_store_required',
        `Choose the ${d.name} pickup store for ${account.name} in Settings › Couriers first.`,
      );

    const recipientPhone = order.shippingAddress.phone ?? order.customer.phone;
    const phone = recipientPhone ? nationalDigits(recipientPhone) : null;
    if (!phone || !MOBILE_BD.test(phone))
      throw AppError.unprocessable(
        'courier_phone_invalid',
        `Couriers need a Bangladeshi mobile number (01XXXXXXXXX) for ${order.number}.`,
      );
    const customerPhone = order.customer.phone ? nationalDigits(order.customer.phone) : null;
    const altPhone =
      customerPhone && customerPhone !== phone && MOBILE_BD.test(customerPhone)
        ? customerPhone
        : undefined;

    const due =
      order.payment.status === 'refunded'
        ? 0
        : Math.max(0, order.totalMinor - order.payment.paidMinor);
    const codMinor = input.codMinor ?? due;
    if (codMinor % 100 !== 0)
      throw AppError.unprocessable(
        'cod_not_whole_taka',
        `Couriers collect whole taka. Set the amount to collect for ${order.number} to a whole number.`,
        { dueMinor: due },
      );

    let weightGrams =
      input.weightGrams ?? (await this.itemsWeight(order)) ?? account.defaultWeightGrams;
    weightGrams = Math.max(d.weightGrams.min, weightGrams);
    if (weightGrams > d.weightGrams.max)
      throw AppError.unprocessable(
        'parcel_too_heavy',
        `${d.name} takes parcels up to ${d.weightGrams.max / 1000} kg.`,
      );

    const location = this.location(d.location, input.location);
    if (d.locationRequired && !location)
      throw AppError.unprocessable(
        'courier_location_required',
        `Choose the ${d.name} delivery area.`,
      );

    const attempt = (await this.parcels.count({ orderId: order._id })) + 1;
    if (attempt > MAX_ATTEMPTS)
      throw AppError.unprocessable(
        'too_many_bookings',
        `${order.number} has been booked too many times.`,
      );
    const a = order.shippingAddress;
    const quantity = order.items.reduce((n, i) => n + i.quantity, 0) || 1;
    const now = new Date();
    try {
      const parcel = await this.parcels.create({
        orderId: order._id,
        orderNumber: order.number,
        accountId: account._id,
        provider: account.provider,
        accountName: account.name,
        invoice: attempt === 1 ? order.number : `${order.number}-${attempt}`,
        attempt,
        status: 'queued',
        current: true,
        recipient: {
          name: a.name ?? order.customer.name,
          phone,
          ...(altPhone ? { altPhone } : {}),
          address: [a.line1, a.area, a.city, a.district, a.postcode].filter(Boolean).join(', '),
        },
        codMinor,
        valueMinor: order.totalMinor,
        weightGrams,
        quantity,
        description: describeItems(order),
        ...(input.note ? { note: input.note } : {}),
        ...(location ? { location } : {}),
        events: [{ at: now, status: 'queued', source: 'booking' }],
        checkFailures: 0,
        createdBy: this.actor(),
      });
      await this.syncShipment(parcel, false);
      return parcel;
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict(
          'parcel_exists',
          `${order.number} is already booked with a courier.`,
        );
      throw err;
    }
  }

  private location(
    kind: 'none' | 'city_zone_area' | 'area',
    loc?: ParcelLocation,
  ): ParcelLocation | undefined {
    if (!loc || kind === 'none') return undefined;
    if (kind === 'area')
      return loc.areaId && loc.areaName
        ? { areaId: loc.areaId, areaName: loc.areaName }
        : undefined;
    if (!loc.cityId) return undefined;
    if (loc.areaId && !loc.zoneId)
      throw AppError.validation([
        { path: 'location.zoneId', message: 'Choose the zone of the area' },
      ]);
    return loc;
  }

  /** Total weight from the products' variant weights, when every item has one. */
  private async itemsWeight(order: OrderDoc): Promise<number | null> {
    const products = await this.products.getMany([
      ...new Set(order.items.map((i) => i.productId.toHexString())),
    ]);
    let total = 0;
    for (const item of order.items) {
      const variant = products
        .find((p) => p._id.equals(item.productId))
        ?.variants.find((v) => v._id.equals(item.variantId));
      if (!variant?.weightGrams) return null;
      total += variant.weightGrams * item.quantity;
    }
    return total > 0 ? total : null;
  }

  /**
   * Sends a queued parcel to the courier. Runs inline for single bookings and from the
   * couriers queue for bulk ones. A parcel found mid-send (a crash, or a lost reply) is
   * never sent again; it goes to the lost-reply check instead.
   */
  async send(parcelId: string): Promise<ParcelDoc> {
    const claimed = await this.parcels.findOneAndUpdate(
      { _id: new Types.ObjectId(parcelId), status: 'queued' },
      {
        $set: { status: 'sending', sendStartedAt: new Date() },
        $push: {
          events: {
            $each: [{ at: new Date(), status: 'sending', source: 'booking' }],
            $slice: -MAX_EVENTS,
          },
        },
      },
    );
    if (!claimed) {
      const p = await this.get(parcelId);
      return p.status === 'sending' ? this.resolveLost(p, 'system') : p;
    }
    const parcel = claimed;
    const order = await this.orders.get(parcel.orderId.toHexString()).catch(() => null);
    if (!order || !BOOKABLE.includes(order.status))
      return this.finish(parcel, 'cancelled', {
        note: 'Not sent: the order was changed before it went to the courier.',
      });
    const account = await this.accounts.get(parcel.accountId.toHexString()).catch(() => null);
    if (!account?.enabled)
      return this.finish(parcel, 'failed', {
        error: 'Not sent: the courier account was removed or turned off.',
      });

    const provider = this.accounts.provider(account.provider);
    let result: BookingResult;
    try {
      result = await provider.book(this.accounts.context(account), this.bookingRequest(parcel));
    } catch (err) {
      if (err instanceof CourierError && err.kind !== 'uncertain' && err.kind !== 'unavailable') {
        if (err.kind === 'auth') await this.accounts.markRejected(account._id, err.message);
        return this.finish(parcel, 'failed', { error: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof CourierError))
        this.logger.error({ err, parcelId }, 'Courier booking failed unexpectedly');
      return this.markLost(parcel, provider, message);
    }
    await this.accounts.markWorking(account._id);
    return this.markBooked(parcel, provider, result, 'booking');
  }

  private bookingRequest(p: ParcelDoc): BookingRequest {
    return {
      invoice: p.invoice,
      recipient: p.recipient,
      codMinor: p.codMinor,
      valueMinor: p.valueMinor,
      weightGrams: p.weightGrams,
      quantity: p.quantity,
      description: p.description,
      ...(p.note ? { note: p.note } : {}),
      ...(p.location ? { location: p.location } : {}),
    };
  }

  private async markBooked(
    parcel: ParcelDoc,
    provider: CourierProvider,
    result: BookingResult,
    source: ParcelEventSource,
  ): Promise<ParcelDoc> {
    const status = provider.translate(result.providerStatus, 'booked').status ?? 'booked';
    const now = new Date();
    const updated = await this.parcels.findOneAndUpdate(
      { _id: parcel._id, status: 'sending' },
      {
        $set: {
          status,
          providerStatus: result.providerStatus,
          consignmentId: result.consignmentId,
          ...(result.trackingCode ? { trackingCode: result.trackingCode } : {}),
          ...(result.deliveryFeeMinor !== undefined
            ? { deliveryFeeMinor: result.deliveryFeeMinor }
            : {}),
          bookedAt: now,
          lastCheckedAt: now,
          checkFailures: 0,
          ...(isFinal(status)
            ? {}
            : { nextCheckAt: new Date(now.getTime() + (CHECK_EVERY[status] ?? HOUR)) }),
        },
        $unset: { attention: '', error: '', ...(isFinal(status) ? { nextCheckAt: '' } : {}) },
        $push: {
          events: {
            $each: [
              {
                at: now,
                status,
                providerStatus: result.providerStatus,
                source,
                note: `Consignment ${result.consignmentId}`,
              },
            ],
            $slice: -MAX_EVENTS,
          },
        },
      },
    );
    if (!updated) {
      // Staff marked it cancelled while the courier was answering: the courier has it anyway.
      const after = await this.parcels.findOneAndUpdate(
        { _id: parcel._id },
        {
          $set: {
            consignmentId: result.consignmentId,
            ...(result.trackingCode ? { trackingCode: result.trackingCode } : {}),
            attention: `${parcel.accountName} booked this parcel (consignment ${result.consignmentId}) after it was cancelled here. Cancel it with ${parcel.accountName}.`,
          },
        },
      );
      if (after) await this.syncShipment(after);
      return after ?? parcel;
    }
    await this.syncShipment(updated);
    await this.audit.record({
      action: 'parcel.booked',
      orgId: this.orgId(),
      target: { type: 'order', id: parcel.orderId.toHexString(), label: parcel.orderNumber },
      metadata: {
        provider: parcel.provider,
        consignmentId: result.consignmentId,
        codMinor: parcel.codMinor,
      },
    });
    return updated;
  }

  /** The booking was sent but no answer came back. */
  private async markLost(
    parcel: ParcelDoc,
    provider: CourierProvider,
    message: string,
  ): Promise<ParcelDoc> {
    const name = parcel.accountName;
    const canLookUp = Boolean(provider.statusByInvoice);
    const attention = canLookUp
      ? `No answer from ${name} (${message}). Sellora is checking whether the booking went through.`
      : `No answer from ${name} (${message}), so Sellora cannot tell whether the parcel was booked. Look for invoice ${parcel.invoice} in the ${name} panel, then enter its consignment id here, or mark it not booked.`;
    const updated = await this.parcels.findOneAndUpdate(
      { _id: parcel._id, status: 'sending' },
      {
        $set: {
          attention,
          checkFailures: 0,
          ...(canLookUp ? { nextCheckAt: new Date(Date.now() + LOST_CHECKS_MS[0]!) } : {}),
        },
        ...(canLookUp ? {} : { $unset: { nextCheckAt: '' } }),
      },
    );
    if (updated) await this.syncShipment(updated);
    return updated ?? (await this.get(parcel._id.toHexString()));
  }

  /** Asks the courier whether a booking whose reply was lost exists (by our invoice). */
  private async resolveLost(parcel: ParcelDoc, source: ParcelEventSource): Promise<ParcelDoc> {
    const account = await this.accounts.get(parcel.accountId.toHexString()).catch(() => null);
    const provider = account ? this.accounts.provider(account.provider) : null;
    if (!account || !provider?.statusByInvoice) return parcel;
    let found;
    try {
      found = await provider.statusByInvoice(this.accounts.context(account), parcel.invoice);
    } catch (err) {
      if (!(err instanceof CourierError)) throw err;
      return this.scheduleLostCheck(parcel);
    }
    if (found === 'not_found') {
      // Give the courier a few minutes before concluding the booking never arrived.
      const started = parcel.sendStartedAt?.getTime() ?? parcel.createdAt.getTime();
      if (Date.now() - started < LOST_CHECKS_MS[1]!) return this.scheduleLostCheck(parcel);
      return this.finish(parcel, 'failed', {
        error: `${parcel.accountName} has no booking with invoice ${parcel.invoice}, so it was not made. Book again.`,
        from: 'sending',
      });
    }
    const status = provider.translate(found.providerStatus, 'booked').status ?? 'booked';
    const now = new Date();
    const updated = await this.parcels.findOneAndUpdate(
      { _id: parcel._id, status: 'sending' },
      {
        $set: {
          status,
          providerStatus: found.providerStatus,
          bookedAt: now,
          lastCheckedAt: now,
          checkFailures: 0,
          ...(isFinal(status) ? {} : { nextCheckAt: new Date(now.getTime() + HOUR) }),
        },
        $unset: { attention: '', ...(isFinal(status) ? { nextCheckAt: '' } : {}) },
        $push: {
          events: {
            $each: [
              {
                at: now,
                status,
                providerStatus: found.providerStatus,
                source,
                note: `Found by invoice ${parcel.invoice}`,
              },
            ],
            $slice: -MAX_EVENTS,
          },
        },
      },
    );
    if (!updated) return this.get(parcel._id.toHexString());
    await this.syncShipment(updated);
    await this.syncOrder(updated);
    return updated;
  }

  private async scheduleLostCheck(parcel: ParcelDoc): Promise<ParcelDoc> {
    const n = parcel.checkFailures + 1;
    const delay = LOST_CHECKS_MS[n];
    const updated = await this.parcels.findOneAndUpdate(
      { _id: parcel._id, status: 'sending' },
      delay
        ? { $set: { checkFailures: n, nextCheckAt: new Date(Date.now() + delay) } }
        : {
            $set: {
              checkFailures: n,
              attention: `${parcel.accountName} still cannot say whether invoice ${parcel.invoice} was booked. Check the ${parcel.accountName} panel, then enter its consignment id here, or mark it not booked.`,
            },
            $unset: { nextCheckAt: '' },
          },
    );
    if (updated && !delay) await this.syncShipment(updated);
    return updated ?? parcel;
  }

  /** Ends a parcel that will not be tracked further (cancelled or failed). */
  private async finish(
    parcel: ParcelDoc,
    status: 'cancelled' | 'failed',
    opts: { error?: string; note?: string; from?: ShipmentStatus; source?: ParcelEventSource },
  ): Promise<ParcelDoc> {
    const now = new Date();
    const updated = await this.parcels.findOneAndUpdate(
      { _id: parcel._id, status: opts.from ?? parcel.status },
      {
        $set: { status, current: false, ...(opts.error ? { error: opts.error } : {}) },
        $unset: { nextCheckAt: '', attention: '' },
        $push: {
          events: {
            $each: [
              { at: now, status, source: opts.source ?? 'booking', note: opts.note ?? opts.error },
            ],
            $slice: -MAX_EVENTS,
          },
        },
      },
    );
    const result = updated ?? (await this.get(parcel._id.toHexString()));
    if (updated) {
      await this.syncShipment(updated);
      if (status === 'failed')
        await this.audit.record({
          action: 'parcel.failed',
          orgId: this.orgId(),
          target: { type: 'order', id: parcel.orderId.toHexString(), label: parcel.orderNumber },
          metadata: { provider: parcel.provider, error: opts.error ?? null },
        });
    }
    return result;
  }

  // ---------------------------------------------------------------- tracking

  /** Asks the courier where a parcel is and applies the answer. */
  async check(parcelId: string, source: ParcelEventSource): Promise<ParcelDoc> {
    const parcel = await this.get(parcelId);
    if (parcel.status === 'sending') return this.resolveLost(parcel, source);
    if (!TRACKED_STATUSES.includes(parcel.status)) {
      if (parcel.nextCheckAt)
        await this.parcels.updateOne({ _id: parcel._id }, { $unset: { nextCheckAt: '' } });
      return parcel;
    }
    const account = await this.accounts.get(parcel.accountId.toHexString()).catch(() => null);
    if (!account) {
      await this.parcels.updateOne({ _id: parcel._id }, { $unset: { nextCheckAt: '' } });
      return parcel;
    }
    const provider = this.accounts.provider(account.provider);
    let providerStatus: string;
    try {
      ({ providerStatus } = await provider.status(this.accounts.context(account), {
        invoice: parcel.invoice,
        ...(parcel.consignmentId ? { consignmentId: parcel.consignmentId } : {}),
        ...(parcel.trackingCode ? { trackingCode: parcel.trackingCode } : {}),
      }));
    } catch (err) {
      if (!(err instanceof CourierError)) throw err;
      if (err.kind === 'auth') await this.accounts.markRejected(account._id, err.message);
      const failures = parcel.checkFailures + 1;
      const backoff = Math.min(HOUR * 2 ** (failures - 1), 12 * HOUR);
      await this.parcels.updateOne(
        { _id: parcel._id },
        { $set: { checkFailures: failures, nextCheckAt: new Date(Date.now() + backoff) } },
      );
      if (source === 'staff') throw new AppError('courier_unavailable', 503, err.message);
      return this.get(parcelId);
    }
    await this.accounts.markWorking(account._id);
    return this.apply(parcel, provider, providerStatus, source);
  }

  private attentionFor(status: ShipmentStatus, name: string): string | undefined {
    switch (status) {
      case 'returned':
        return `${name} says the parcel was returned. When it reaches you, mark the order returned and choose whether to restock.`;
      case 'returning':
        return `${name} is bringing the parcel back.`;
      case 'partly_delivered':
        return `${name} delivered part of the parcel. Check what came back and update the order.`;
      case 'cancelled':
        return `${name} cancelled the booking before pickup. Book again or cancel the order.`;
      case 'on_hold':
        return `${name} put the parcel on hold. Check with ${name} or the customer.`;
      case 'queued':
      case 'sending':
      case 'booked':
      case 'picked_up':
      case 'in_transit':
      case 'delivered':
      case 'failed':
        return undefined;
    }
  }

  private async apply(
    parcel: ParcelDoc,
    provider: CourierProvider,
    providerStatus: string,
    source: ParcelEventSource,
  ): Promise<ParcelDoc> {
    const translation = provider.translate(providerStatus, parcel.status);
    const status = translation.status ?? parcel.status;
    const changed = status !== parcel.status || providerStatus !== parcel.providerStatus;
    const now = new Date();
    const set: Record<string, unknown> = { lastCheckedAt: now, checkFailures: 0, providerStatus };
    const unset: Record<string, ''> = {};
    const push: ParcelEvent[] = [];

    if (changed) {
      set.status = status;
      if (status === 'cancelled') set.current = false;
      const attention =
        translation.attention ??
        (translation.status === null
          ? `${parcel.accountName} reported "${providerStatus}", a status Sellora does not know yet. Check the parcel with ${parcel.accountName}.`
          : this.attentionFor(status, parcel.accountName));
      if (attention) set.attention = attention;
      else unset.attention = '';
      push.push({ at: now, status, providerStatus, source });
    }
    const booked = parcel.bookedAt?.getTime() ?? parcel.createdAt.getTime();
    if (isFinal(status)) unset.nextCheckAt = '';
    else if (now.getTime() - booked > GIVE_UP_AFTER_MS) {
      unset.nextCheckAt = '';
      set.attention = `No final update from ${parcel.accountName} in 45 days. Check the parcel with ${parcel.accountName}.`;
    } else set.nextCheckAt = new Date(now.getTime() + (CHECK_EVERY[status] ?? HOUR));

    const updated = await this.parcels.findOneAndUpdate(
      { _id: parcel._id, status: parcel.status },
      {
        $set: set,
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
        ...(push.length ? { $push: { events: { $each: push, $slice: -MAX_EVENTS } } } : {}),
      },
    );
    // Someone else applied a newer answer in the meantime; theirs stands.
    if (!updated) return this.get(parcel._id.toHexString());
    if (changed) {
      await this.syncShipment(updated);
      await this.syncOrder(updated);
      this.emitOutcome(parcel.status, updated);
    }
    return updated;
  }

  /** Tells the fraud check what happened, once per parcel end (courier-confirmed only). */
  private emitOutcome(before: ShipmentStatus, p: ParcelDoc): void {
    const outcome =
      p.status === 'delivered' || p.status === 'partly_delivered'
        ? 'delivered'
        : p.status === 'returned'
          ? 'returned'
          : null;
    const was =
      before === 'delivered' || before === 'partly_delivered'
        ? 'delivered'
        : before === 'returned'
          ? 'returned'
          : null;
    const phone = normalizePhone(p.recipient.phone, 'BD');
    if (!outcome || outcome === was || !phone) return;
    this.events.emit(PARCEL_OUTCOME, {
      orgId: p.orgId.toHexString(),
      parcelId: p._id.toHexString(),
      phone,
      outcome,
    } satisfies ParcelOutcomeEvent);
  }

  /**
   * Moves the order along with the parcel: picked up means shipped, delivered means
   * delivered. Returns and partial deliveries are left to staff (restocking needs a person).
   */
  private async syncOrder(parcel: ParcelDoc): Promise<void> {
    if (!parcel.current) return;
    const id = parcel.orderId.toHexString();
    const name = parcel.accountName;
    try {
      let order = await this.orders.get(id);
      if (PICKED_UP.includes(parcel.status) && BOOKABLE.includes(order.status))
        order = await this.orders.changeStatus(id, 'shipped', {
          note: `${name}: ${parcel.providerStatus ?? parcel.status} (consignment ${parcel.consignmentId ?? parcel.invoice})`,
        });
      if (parcel.status === 'delivered' && order.status === 'shipped')
        await this.orders.changeStatus(id, 'delivered', { note: `Delivered by ${name}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { err, parcelId: parcel._id.toHexString() },
        'Could not move the order with its parcel',
      );
      const after = await this.parcels.findOneAndUpdate(
        { _id: parcel._id },
        { $set: { attention: `Sellora could not update the order: ${message}` } },
      );
      if (after) await this.syncShipment(after);
    }
  }

  /** Copies the parcel onto its order. Older parcels never overwrite a newer one. */
  private async syncShipment(p: ParcelDoc, guard = true): Promise<void> {
    await this.orders.setShipment(
      p.orderId,
      {
        parcelId: p._id,
        provider: p.provider,
        accountName: p.accountName,
        ...(p.consignmentId ? { consignmentId: p.consignmentId } : {}),
        ...(p.trackingCode ? { trackingCode: p.trackingCode } : {}),
        status: p.status,
        ...(p.attention ? { attention: p.attention } : {}),
        updatedAt: new Date(),
      },
      guard ? p._id : undefined,
    );
  }

  // ---------------------------------------------------------------- staff actions

  /** "Check now" from the order page. At most once every 30 seconds per parcel. */
  async refresh(parcelId: string): Promise<ParcelDoc> {
    const parcel = await this.get(parcelId);
    const fresh = await this.redis.set(`courier:refresh:${parcelId}`, '1', 'EX', 30, 'NX');
    if (!fresh)
      throw AppError.tooManyRequests('Checked a moment ago. Try again in 30 seconds.', 30);
    return this.check(parcel._id.toHexString(), 'staff');
  }

  /**
   * Staff cancelled the booking with the courier (or it never went through): the parcel
   * stops counting, so the order can be cancelled or booked again.
   */
  async cancel(parcelId: string, note?: string): Promise<ParcelDoc> {
    const parcel = await this.get(parcelId);
    if (!['queued', 'sending', 'booked'].includes(parcel.status))
      throw AppError.conflict(
        'parcel_not_cancellable',
        parcel.status === 'cancelled' || parcel.status === 'failed'
          ? 'This parcel is already closed.'
          : `${parcel.accountName} already has the parcel (${parcel.status.replace('_', ' ')}); it cannot be cancelled here.`,
      );
    const now = new Date();
    const updated = await this.parcels.findOneAndUpdate(
      { _id: parcel._id, status: parcel.status },
      {
        $set: { status: 'cancelled', current: false },
        $unset: { nextCheckAt: '', attention: '' },
        $push: {
          events: {
            $each: [
              {
                at: now,
                status: 'cancelled',
                source: 'staff',
                note:
                  note ??
                  (parcel.status === 'sending'
                    ? 'Marked not booked'
                    : 'Cancelled with the courier'),
              },
            ],
            $slice: -MAX_EVENTS,
          },
        },
      },
    );
    if (!updated)
      throw AppError.conflict(
        'parcel_changed',
        'The parcel was just updated. Reload and try again.',
      );
    await this.syncShipment(updated);
    await this.audit.record({
      action: 'parcel.cancelled',
      orgId: this.orgId(),
      target: { type: 'order', id: parcel.orderId.toHexString(), label: parcel.orderNumber },
      metadata: {
        provider: parcel.provider,
        from: parcel.status,
        consignmentId: parcel.consignmentId ?? null,
      },
    });
    return updated;
  }

  /** After a lost reply, staff found the booking in the courier's panel. */
  async link(
    parcelId: string,
    input: { consignmentId: string; trackingCode?: string },
  ): Promise<ParcelDoc> {
    const parcel = await this.get(parcelId);
    if (parcel.status !== 'sending')
      throw AppError.conflict(
        'parcel_not_linkable',
        'Only a booking without an answer from the courier can be linked.',
      );
    const provider = this.accounts.provider(parcel.provider);
    const updated = await this.markBooked(
      parcel,
      provider,
      {
        consignmentId: input.consignmentId,
        trackingCode: input.trackingCode ?? input.consignmentId,
        providerStatus: parcel.providerStatus ?? 'booked',
      },
      'staff',
    );
    // Ask the courier for the real status straight away.
    await this.enqueue(COURIER_CHECK_JOB, updated, 'staff');
    return updated;
  }

  async dismiss(parcelId: string): Promise<ParcelDoc> {
    const parcel = await this.get(parcelId);
    const updated = await this.parcels.findOneAndUpdate(
      { _id: parcel._id },
      { $unset: { attention: '' } },
    );
    if (updated) await this.syncShipment(updated);
    return updated ?? parcel;
  }

  /** The order settled (delivered, returned, cancelled): nothing is left to look at. */
  async orderSettled(orderId: string): Promise<void> {
    const parcels = await this.parcels.find({
      orderId: new Types.ObjectId(orderId),
      attention: { $type: 'string' },
    });
    for (const p of parcels) {
      const updated = await this.parcels.findOneAndUpdate(
        { _id: p._id },
        { $unset: { attention: '' } },
      );
      if (updated) await this.syncShipment(updated);
    }
  }

  // ---------------------------------------------------------------- webhooks and schedules

  /** Parcels of this account named in a webhook; each gets a status check soon. */
  async nudge(
    accountId: Types.ObjectId,
    refs: { consignmentIds: string[]; trackingCodes: string[]; invoices: string[] },
  ) {
    const or: Record<string, unknown>[] = [];
    if (refs.consignmentIds.length)
      or.push({ consignmentId: { $in: refs.consignmentIds.slice(0, 20) } });
    if (refs.trackingCodes.length)
      or.push({ trackingCode: { $in: refs.trackingCodes.slice(0, 20) } });
    if (refs.invoices.length) or.push({ invoice: { $in: refs.invoices.slice(0, 20) } });
    if (!or.length) return 0;
    const parcels = await this.parcels.find(
      { accountId, $or: or, status: { $in: [...TRACKED_STATUSES, 'sending'] } },
      { limit: 20 },
    );
    for (const p of parcels) await this.enqueue(COURIER_CHECK_JOB, p, 'webhook', 3_000);
    return parcels.length;
  }

  /** Queues a status check for every parcel that is due, across businesses (worker only). */
  async queueDueChecks(limit = 500): Promise<number> {
    const due = await this.parcelModel
      .find({ nextCheckAt: { $lte: new Date() } }, { _id: 1, orgId: 1 }, { [CROSS_TENANT]: true })
      .sort({ nextCheckAt: 1 })
      .limit(limit)
      .lean<Pick<ParcelDoc, '_id' | 'orgId'>[]>()
      .exec();
    for (const p of due) await this.enqueue(COURIER_CHECK_JOB, p, 'poll');
    return due.length;
  }
}

/** "2 × Red saree (L), 1 × Blue panjabi", at most 250 characters. */
export function describeItems(order: Pick<OrderDoc, 'items'>): string {
  const text = order.items
    .map((i) => {
      const variant = i.variantTitle && i.variantTitle !== 'Default' ? ` (${i.variantTitle})` : '';
      return `${i.quantity} × ${i.name}${variant}`;
    })
    .join(', ');
  return text.length > 250 ? `${text.slice(0, 249)}…` : text;
}
