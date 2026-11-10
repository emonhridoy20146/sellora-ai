import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { AuditService } from '../audit/audit.service.js';
import { GatewayError } from '../billing/payments/gateway.types.js';
import { OrdersService, type OrderDoc } from '../commerce/orders.service.js';
import { OrderRepository } from '../commerce/repositories.js';
import type { PaymentMethod, ShopGatewayKey } from '../commerce/schemas.js';
import { checkoutOptions, type CheckoutPaymentOptions } from './checkout-options.js';
import { ShopGateways } from './gateways/shop-gateways.js';
import type { ShopVerified } from './gateways/shop-gateway.types.js';
import { ShopPaymentRepository } from './repositories.js';
import type { ShopPayment } from './schemas.js';
import { ShopPaymentAccountsService } from './shop-payment-accounts.service.js';

export type ShopPaymentDoc = WithId<ShopPayment>;

/** The shopper's choice at checkout; leaving it out means cash on delivery. */
export interface PaymentChoice {
  method: 'cod' | 'online';
  gateway?: ShopGatewayKey;
}

/** What the order is created with, from the shopper's choice and the business's options. */
export interface PaymentPlan {
  method: PaymentMethod;
  online?: {
    gateway: ShopGatewayKey;
    purpose: 'full' | 'advance';
    sandbox: boolean;
    due: (t: { totalMinor: number; deliveryChargeMinor: number }) => number;
  };
}

/** What the storefront does after the order: send the shopper to the gateway, or not. */
export interface PaymentStart {
  gateway: ShopGatewayKey;
  amountMinor: number;
  redirectUrl: string | null;
  error: string | null;
}

export type ReturnOutcome = 'done' | 'success' | 'fail' | 'cancel';

/** Attempts still `started` this long are asked about by the worker. */
const CHECK_AFTER_MS = 3 * 60_000;
const CHECK_EVERY_MS = 4 * 60_000;
/** After this, an attempt the gateway never settled is given up as failed. */
const GIVE_UP_AFTER_MS = 2 * 86_400_000;
const SWEEP_BATCH = 100;

const GATEWAY_METHOD: Record<ShopGatewayKey, PaymentMethod> = {
  bkash: 'bkash',
  nagad: 'nagad',
  sslcommerz: 'online',
  aamarpay: 'online',
  shurjopay: 'online',
};

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 16 letters and digits: fits every gateway's order id (Nagad and aamarPay are the shortest). */
function newRef(): string {
  const bytes = randomBytes(14);
  return `SP${Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('')}`;
}

/**
 * Shoppers paying businesses at checkout with the business's own gateway accounts (ADR 0029):
 * the options for a cart, the start of a payment, the gateway's answer (always checked with
 * the gateway itself), and the worker's check of attempts whose shopper never came back.
 */
@Injectable()
export class ShopPaymentsService {
  private readonly logger = new Logger(ShopPaymentsService.name);

  constructor(
    @InjectModel('ShopPayment') private readonly model: Model<ShopPayment>,
    private readonly payments: ShopPaymentRepository,
    private readonly accounts: ShopPaymentAccountsService,
    private readonly gateways: ShopGateways,
    private readonly orders: OrdersService,
    private readonly orderRepo: OrderRepository,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- checkout

  /** What the shopper may choose for this cart (runs inside the business). */
  async options(cart: {
    totalMinor: number;
    deliveryChargeMinor: number;
    zoneId: string | null;
    currency: string;
  }): Promise<CheckoutPaymentOptions> {
    const [settings, choices] = await Promise.all([
      this.accounts.settings(),
      // All five gateways take taka only.
      cart.currency === 'BDT' ? this.accounts.choices() : Promise.resolve([]),
    ]);
    return checkoutOptions(settings, choices, cart);
  }

  /**
   * The rules for a page that prices its own form (landing pages): the same options with the
   * advance rule instead of an amount, so the form can show the advance as the shopper picks.
   */
  async rules(currency: string) {
    const [settings, choices] = await Promise.all([
      this.accounts.settings(),
      currency === 'BDT' ? this.accounts.choices() : Promise.resolve([]),
    ]);
    const o = checkoutOptions(settings, choices, {
      totalMinor: 0,
      deliveryChargeMinor: 0,
      zoneId: null,
    });
    return {
      cod: o.cod,
      fullOnline: o.fullOnline,
      gateways: o.gateways,
      advance:
        o.gateways.length && o.cod && settings.advance.mode !== 'off'
          ? {
              mode: settings.advance.mode,
              fixedMinor: settings.advance.fixedMinor,
              percent: settings.advance.percent,
              zoneIds: settings.advance.zoneIds,
              minTotalMinor: settings.advance.minTotalMinor,
            }
          : null,
    };
  }

  /** Checks the shopper's choice against the options; a wrong choice is a 422 on `payment`. */
  plan(choice: PaymentChoice | undefined, options: CheckoutPaymentOptions): PaymentPlan {
    const method = choice?.method ?? 'cod';
    const gateway = choice?.gateway
      ? options.gateways.find((g) => g.key === choice.gateway)
      : undefined;
    if (choice?.gateway && !gateway)
      throw AppError.validation([
        { path: 'payment.gateway', message: 'This way to pay is not available. Choose another.' },
      ]);
    if (method === 'online') {
      if (!options.fullOnline)
        throw AppError.validation([
          { path: 'payment.method', message: 'This shop does not take online payment.' },
        ]);
      if (!gateway)
        throw AppError.validation([{ path: 'payment.gateway', message: 'Choose how to pay' }]);
      return {
        method: GATEWAY_METHOD[gateway.key],
        online: {
          gateway: gateway.key,
          purpose: 'full',
          sandbox: gateway.sandbox,
          due: (t) => t.totalMinor,
        },
      };
    }
    if (!options.cod)
      throw AppError.validation([
        { path: 'payment.method', message: 'This shop takes online payment only.' },
      ]);
    if (options.advanceMinor > 0) {
      if (!gateway)
        throw AppError.validation([
          { path: 'payment.gateway', message: 'Choose how to pay the advance' },
        ]);
      const advance = options.advanceMinor;
      return {
        method: 'cod',
        online: {
          gateway: gateway.key,
          purpose: 'advance',
          sandbox: gateway.sandbox,
          // Asked as quoted; the order total caps it.
          due: (t) => Math.min(advance, t.totalMinor),
        },
      };
    }
    return { method: 'cod' };
  }

  private apiUrl(path: string): string {
    return `${this.config.get('API_PUBLIC_URL').replace(/\/$/, '')}/v1/shop-payments/${path}`;
  }

  /** What is still to be paid online on this order; 0 when nothing (or it is paid). */
  amountDue(order: OrderDoc): number {
    const online = order.payment.online;
    if (!online || online.status === 'paid' || order.payment.status === 'refunded') return 0;
    if (['cancelled', 'returned'].includes(order.status)) return 0;
    const left = Math.max(0, order.totalMinor - order.payment.paidMinor);
    return online.purpose === 'full' ? left : Math.min(online.dueMinor, left);
  }

  /**
   * Starts a payment for the order with `gateway` and the business's account. Gateway
   * problems never throw: the order stands, and the answer says what went wrong.
   */
  async start(
    order: OrderDoc,
    gateway: ShopGatewayKey,
    opts: { returnUrl: string; description: string },
  ): Promise<PaymentStart> {
    const amountMinor = this.amountDue(order);
    if (amountMinor <= 0)
      throw AppError.conflict('nothing_to_pay', 'There is nothing left to pay online.');
    const account = await this.accounts.enabledFor(gateway);
    const adapter = this.gateways.get(gateway);
    const name = adapter.descriptor.name;
    if (!account)
      throw AppError.validation([
        { path: 'gateway', message: 'This way to pay is not available. Choose another.' },
      ]);
    const ref = newRef();
    const payment = await this.payments.create({
      orderId: order._id,
      orderNumber: order.number,
      ref,
      gateway,
      accountId: account._id,
      sandbox: account.sandbox,
      purpose: order.payment.online!.purpose,
      amountMinor,
      currency: order.currency,
      status: 'started',
      settled: false,
      returnUrl: opts.returnUrl,
    });
    await this.orders.setOnlinePayment(order._id.toHexString(), {
      status: 'awaiting',
      gateway,
      sandbox: account.sandbox,
    });
    try {
      const started = await adapter.start(this.accounts.credentials(account), account.sandbox, {
        ref,
        amountMinor,
        currency: order.currency,
        description: opts.description,
        customer: {
          name: order.customer.name,
          phone: order.customer.phone ?? order.shippingAddress.phone ?? '',
          ...(order.customer.email ? { email: order.customer.email } : {}),
          address: [order.shippingAddress.line1, order.shippingAddress.area]
            .filter(Boolean)
            .join(', '),
          ...(order.shippingAddress.city || order.shippingAddress.district
            ? { city: order.shippingAddress.city ?? order.shippingAddress.district! }
            : {}),
        },
        ...(RequestContext.current()?.ip ? { shopperIp: RequestContext.current()!.ip! } : {}),
        returnUrl: (outcome) => this.apiUrl(`${ref}/return/${outcome}`),
        notifyUrl: this.apiUrl(`${ref}/notify`),
      });
      await this.payments.updateOne(
        { _id: payment._id },
        { $set: { sessionId: started.sessionId } },
      );
      await this.accounts.noteStart(account._id, null);
      return { gateway, amountMinor, redirectUrl: started.redirectUrl, error: null };
    } catch (err) {
      const message =
        err instanceof GatewayError
          ? err.message
          : err instanceof Error && (err.name === 'TimeoutError' || err.name === 'TypeError')
            ? `${name} did not answer`
            : null;
      if (message === null) throw err;
      this.logger.warn(
        { orderId: order._id.toHexString(), gateway, ref, details: (err as GatewayError).details },
        'Shop payment could not start',
      );
      await this.payments.updateOne(
        { _id: payment._id },
        {
          $set: {
            status: 'failed',
            settled: true,
            reason: `start_failed: ${message}`.slice(0, 300),
          },
        },
      );
      await this.accounts.noteStart(account._id, message);
      await this.orders.setOnlinePayment(order._id.toHexString(), { status: 'failed' });
      return {
        gateway,
        amountMinor,
        redirectUrl: null,
        error: `${name} could not start the payment. Try again in a moment or choose another way to pay.`,
      };
    }
  }

  // ---------------------------------------------------------------- the gateway's answer

  /** The attempt behind a gateway's return address, found across businesses by its ref. */
  private async byRef(ref: string): Promise<ShopPaymentDoc | null> {
    if (!/^SP[A-Z0-9]{14}$/.test(ref)) return null;
    return this.model
      .findOne({ ref })
      .setOptions({ [CROSS_TENANT]: true })
      .lean<ShopPaymentDoc>()
      .exec();
  }

  private inTenant<T>(p: ShopPaymentDoc, fn: () => Promise<T>): Promise<T> {
    return RequestContext.withTenant(p.orgId.toHexString(), fn, {
      type: 'system',
      id: 'shop-payments',
    });
  }

  /** Where to send the shopper, with what happened. */
  private shopperUrl(p: Pick<ShopPayment, 'returnUrl'>, outcome: string): string {
    const url = new URL(p.returnUrl);
    url.searchParams.set('payment', outcome);
    return url.toString();
  }

  /**
   * The shopper is back from the gateway (or SSLCommerz's server told us). Asks the gateway,
   * records the answer and says where to send the shopper; null for an unknown reference.
   */
  async handleReturn(
    ref: string,
    outcome: ReturnOutcome | 'notify',
    params: Record<string, string>,
  ): Promise<string | null> {
    const found = await this.byRef(ref);
    if (!found) return null;
    return this.inTenant(found, async () => {
      let result: ShopPaymentDoc = found;
      if (found.status !== 'succeeded') {
        const account = await this.accounts.get(found.accountId.toHexString()).catch(() => null);
        if (account) {
          try {
            const verified = await this.gateways
              .get(found.gateway)
              .complete(
                this.accounts.credentials(account),
                found.sandbox,
                { ref: found.ref, ...(found.sessionId ? { sessionId: found.sessionId } : {}) },
                outcome,
                params,
              );
            result = await this.apply(found, verified);
          } catch (err) {
            if (
              !(err instanceof GatewayError) &&
              !(err instanceof Error && err.name === 'TimeoutError')
            )
              throw err;
            // The worker asks again; the shopper sees "we are checking".
            this.logger.warn({ ref, err: err.message }, 'Could not check a shop payment');
          }
        }
      }
      const shown =
        result.status === 'succeeded'
          ? 'paid'
          : result.status === 'started'
            ? 'pending'
            : result.status;
      return this.shopperUrl(found, shown);
    });
  }

  /** Records what the gateway said. Money moves on the order once per attempt at most. */
  private async apply(p: ShopPaymentDoc, v: ShopVerified): Promise<ShopPaymentDoc> {
    const now = new Date();
    if (v.status === 'pending') {
      return (
        (await this.payments.findOneAndUpdate({ _id: p._id }, { $set: { lastCheckedAt: now } })) ??
        p
      );
    }
    if (v.status === 'succeeded') {
      const sameRef = v.ref === undefined || v.ref === p.ref;
      const sameMoney =
        v.amountMinor === p.amountMinor && (v.currency ?? p.currency) === p.currency;
      if (!sameRef || !sameMoney) {
        await this.audit.record({
          action: 'shop_payment.mismatch',
          orgId: p.orgId.toHexString(),
          target: { type: 'order', id: p.orderId.toHexString(), label: p.orderNumber },
          metadata: {
            ref: p.ref,
            gateway: p.gateway,
            expected: { amountMinor: p.amountMinor, currency: p.currency },
            got: {
              amountMinor: v.amountMinor ?? null,
              currency: v.currency ?? null,
              ref: v.ref ?? null,
            },
          },
        });
        this.logger.error(
          {
            ref: p.ref,
            gateway: p.gateway,
            expected: p.amountMinor,
            got: v.amountMinor,
            gotRef: v.ref,
          },
          'Shop payment does not match the attempt',
        );
        // A payment for another reference says nothing about this one.
        if (!sameRef) return p;
        const failed = await this.payments.findOneAndUpdate(
          { _id: p._id, status: { $ne: 'succeeded' } },
          {
            $set: {
              status: 'failed',
              settled: true,
              reason: 'amount_mismatch',
              lastCheckedAt: now,
              ...(v.raw ? { raw: v.raw } : {}),
            },
          },
        );
        await this.followLatest(p, 'failed');
        return failed ?? p;
      }
      const won = await this.payments.findOneAndUpdate(
        { _id: p._id, status: { $ne: 'succeeded' } },
        {
          $set: {
            status: 'succeeded',
            settled: true,
            verifiedAt: now,
            lastCheckedAt: now,
            ...(v.gatewayRef ? { gatewayRef: v.gatewayRef } : {}),
            ...(v.raw ? { raw: v.raw } : {}),
          },
          $unset: { reason: '' },
        },
      );
      if (!won) return (await this.payments.findById(p._id.toHexString())) ?? p;
      await this.orders.recordOnlinePayment(p.orderId.toHexString(), {
        amountMinor: p.amountMinor,
        ...(v.gatewayRef ? { reference: v.gatewayRef } : {}),
        paymentId: p._id.toHexString(),
        at: now,
      });
      return won;
    }
    // Failed or cancelled. A browser's word changes only an attempt still open; the gateway's
    // final word also settles one the browser said was cancelled.
    const updated = await this.payments.findOneAndUpdate(
      v.settled
        ? { _id: p._id, status: { $ne: 'succeeded' }, settled: false }
        : { _id: p._id, status: 'started' },
      {
        $set: {
          status: v.status,
          settled: v.settled,
          lastCheckedAt: now,
          ...(v.reason ? { reason: v.reason.slice(0, 300) } : {}),
        },
      },
    );
    if (updated) await this.followLatest(p, 'failed');
    return updated ?? p;
  }

  /** The order shows the latest attempt; an older attempt failing changes nothing. */
  private async followLatest(p: ShopPaymentDoc, status: 'failed'): Promise<void> {
    const latest = await this.payments.findOne(
      { orderId: p.orderId },
      { _id: 1 },
      { sort: { createdAt: -1, _id: -1 } },
    );
    if (latest && latest._id.equals(p._id))
      await this.orders.setOnlinePayment(p.orderId.toHexString(), { status });
  }

  // ---------------------------------------------------------------- the worker's check

  /**
   * Asks the gateways about attempts no one has settled: shoppers who paid and closed the
   * browser, and cancels only the browser reported. Each in its own business; one failing
   * never stops the rest.
   */
  async sweep(now = new Date()): Promise<{ checked: number; paid: number; expired: number }> {
    const due = await this.model
      .find({
        settled: false,
        createdAt: { $lte: new Date(now.getTime() - CHECK_AFTER_MS) },
        $or: [
          { lastCheckedAt: { $exists: false } },
          { lastCheckedAt: { $lte: new Date(now.getTime() - CHECK_EVERY_MS) } },
        ],
      })
      .setOptions({ [CROSS_TENANT]: true })
      .sort({ createdAt: 1 })
      .limit(SWEEP_BATCH)
      .lean<ShopPaymentDoc[]>()
      .exec();
    const counts = { checked: 0, paid: 0, expired: 0 };
    for (const p of due) {
      try {
        await this.inTenant(p, async () => {
          const account = await this.accounts.get(p.accountId.toHexString()).catch(() => null);
          let v: ShopVerified | null = null;
          if (account) {
            try {
              v = await this.gateways
                .get(p.gateway)
                .lookup(this.accounts.credentials(account), p.sandbox, {
                  ref: p.ref,
                  ...(p.sessionId ? { sessionId: p.sessionId } : {}),
                });
            } catch (err) {
              if (
                !(err instanceof GatewayError) &&
                !(err instanceof Error && err.name === 'TimeoutError')
              )
                throw err;
              this.logger.warn(
                { ref: p.ref, err: err.message },
                'Gateway check failed; will retry',
              );
            }
          }
          counts.checked += 1;
          const old = p.createdAt.getTime() < now.getTime() - GIVE_UP_AFTER_MS;
          if (v && v.status !== 'pending') {
            const after = await this.apply(p, v);
            if (after.status === 'succeeded' && p.status !== 'succeeded') counts.paid += 1;
            if (v.settled || !old) return;
          }
          if (old) {
            counts.expired += 1;
            const updated = await this.payments.findOneAndUpdate(
              { _id: p._id, settled: false, status: { $ne: 'succeeded' } },
              {
                $set: {
                  settled: true,
                  lastCheckedAt: now,
                  ...(p.status === 'started' ? { status: 'failed', reason: 'expired' } : {}),
                },
              },
            );
            if (updated && p.status === 'started') await this.followLatest(p, 'failed');
          } else {
            await this.payments.updateOne({ _id: p._id }, { $set: { lastCheckedAt: now } });
          }
        });
      } catch (err) {
        this.logger.error({ err, ref: p.ref }, 'Shop payment check failed');
      }
    }
    return counts;
  }

  // ---------------------------------------------------------------- views

  /** The attempts of an order, newest first (the dashboard's order page). */
  async forOrder(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) throw AppError.notFound('order');
    const order = await this.orderRepo.findById(orderId);
    if (!order) throw AppError.notFound('order');
    const list = await this.payments.find(
      { orderId: order._id },
      { sort: { createdAt: -1 }, limit: 20 },
    );
    return list.map((p) => ({
      id: p._id.toHexString(),
      ref: p.ref,
      gateway: p.gateway,
      gatewayName: this.gateways.get(p.gateway).descriptor.name,
      purpose: p.purpose,
      amountMinor: p.amountMinor,
      currency: p.currency,
      status: p.status,
      settled: p.settled,
      sandbox: p.sandbox,
      gatewayRef: p.gatewayRef ?? null,
      reason: p.reason ?? null,
      createdAt: p.createdAt.toISOString(),
      verifiedAt: p.verifiedAt?.toISOString() ?? null,
    }));
  }

  /** What a shopper's receipt says about paying, and whether (and how) they can pay now. */
  async receiptView(order: OrderDoc) {
    const online = order.payment.online;
    const due = this.amountDue(order);
    const choices = due > 0 && order.currency === 'BDT' ? await this.accounts.choices() : [];
    return {
      method: order.payment.method,
      status: order.payment.status,
      paidMinor: order.payment.paidMinor,
      dueMinor:
        order.payment.status === 'refunded'
          ? 0
          : Math.max(0, order.totalMinor - order.payment.paidMinor),
      online: online
        ? {
            gateway: online.gateway,
            gatewayName: this.gateways.get(online.gateway).descriptor.name,
            purpose: online.purpose,
            dueMinor: online.dueMinor,
            status: online.status,
            sandbox: online.sandbox,
          }
        : null,
      payNow: due > 0 && choices.length ? { amountMinor: due, gateways: choices } : null,
    };
  }
}
