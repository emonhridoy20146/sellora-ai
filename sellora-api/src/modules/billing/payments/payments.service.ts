import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types, type Model } from 'mongoose';
import { AppConfig } from '../../../config/app-config.js';
import { RequestContext } from '../../../common/context/request-context.js';
import { randomToken } from '../../../common/crypto/tokens.js';
import { AppError } from '../../../common/errors/app-error.js';
import { isDuplicateKey } from '../../../common/filters/problem-details.filter.js';
import { formatMoney } from '../../../common/money/money.js';
import type { WithId } from '../../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../../infra/database/tenant-guard.plugin.js';
import { TenantScopedRepository } from '../../../infra/database/tenant-scoped.repository.js';
import { TransactionService } from '../../../infra/database/transaction.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { Organization } from '../../orgs/schemas.js';
import type { User } from '../../users/user.schema.js';
import { PlatformSettingsService } from '../../platform/platform-settings.service.js';
import type { BillingInterval } from '../feature-modules.js';
import { InvoicesService } from '../invoices.service.js';
import type { GatewayKey, Payment } from '../payment-schemas.js';
import { PlansService, priceFor } from '../plans.service.js';
import { SubscriptionsService } from '../subscriptions.service.js';
import { WalletService } from '../wallet.service.js';
import { BkashGateway } from './bkash.gateway.js';
import { GatewayConfigService } from './gateway-config.service.js';
import {
  GatewayError,
  type CheckoutRequest,
  type CheckoutSession,
  type VerifiedPayment,
} from './gateway.types.js';
import { SslCommerzGateway } from './sslcommerz.gateway.js';
import { StripeGateway } from './stripe.gateway.js';

export type PaymentDoc = WithId<Payment>;
export type OnlineGateway = Exclude<GatewayKey, 'manual'>;

export const PAYMENT_SUCCEEDED = 'billing.payment_succeeded';
export const MANUAL_PAYMENT_SUBMITTED = 'billing.manual_payment_submitted';

@Injectable()
export class PaymentRepository extends TenantScopedRepository<Payment> {
  constructor(@InjectModel('Payment') model: Model<Payment>) {
    super(model);
  }
}

export interface ManualTransfer {
  method: 'bkash' | 'nagad' | 'rocket' | 'bank' | 'cash';
  senderAccount: string;
  transactionRef: string;
  note?: string;
}

export function toPaymentDto(p: PaymentDoc) {
  return {
    id: p._id.toHexString(),
    purpose: p.purpose,
    amountMinor: p.amountMinor,
    currency: p.currency,
    gateway: p.gateway,
    status: p.status,
    checkoutUrl: p.status === 'pending' ? (p.checkoutUrl ?? null) : null,
    plan: p.plan ?? null,
    manual: p.manual
      ? {
          method: p.manual.method,
          senderAccount: p.manual.senderAccount,
          transactionRef: p.manual.transactionRef,
        }
      : null,
    gatewayRef: p.gatewayRef ?? null,
    failureReason: p.failureReason ?? null,
    reviewNote: p.reviewNote ?? null,
    createdAt: p.createdAt.toISOString(),
    succeededAt: p.succeededAt?.toISOString() ?? null,
  };
}

export function toPlatformPaymentDto(p: PaymentDoc) {
  return {
    ...toPaymentDto(p),
    orgId: p.orgId.toHexString(),
    gatewaySessionId: p.gatewaySessionId ?? null,
    reviewedBy: p.reviewedBy ?? null,
    events: p.events.map((e) => ({ at: e.at.toISOString(), type: e.type })),
  };
}

/**
 * Money coming into the platform: wallet top-ups and plan purchases through SSLCommerz,
 * bKash or Stripe, and manual transfers the super-admin confirms. A payment is credited
 * exactly once (idempotency key `payment:<id>` on the wallet ledger), only after the
 * gateway itself confirmed it, and only if the confirmed amount and currency match.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly payments: PaymentRepository,
    @InjectModel('Payment') private readonly paymentModel: Model<Payment>,
    @InjectModel('Organization') private readonly orgs: Model<Organization>,
    @InjectModel('User') private readonly users: Model<User>,
    private readonly gateways: GatewayConfigService,
    private readonly sslcommerz: SslCommerzGateway,
    private readonly bkash: BkashGateway,
    private readonly stripe: StripeGateway,
    private readonly wallet: WalletService,
    private readonly invoices: InvoicesService,
    private readonly plans: PlansService,
    private readonly subscriptions: SubscriptionsService,
    private readonly settings: PlatformSettingsService,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------- checkout

  private callbackUrls(
    gateway: OnlineGateway,
    paymentId: string,
    orgId: string,
  ): CheckoutRequest['urls'] {
    const api = this.config.get('API_PUBLIC_URL').replace(/\/$/, '');
    const web = this.config.get('WEB_APP_URL').replace(/\/$/, '');
    switch (gateway) {
      case 'sslcommerz':
        return {
          success: `${api}/v1/payments/sslcommerz/return/${paymentId}/success`,
          fail: `${api}/v1/payments/sslcommerz/return/${paymentId}/fail`,
          cancel: `${api}/v1/payments/sslcommerz/return/${paymentId}/cancel`,
          notify: `${api}/v1/payments/sslcommerz/ipn`,
        };
      case 'bkash':
        return {
          success: `${api}/v1/payments/bkash/callback/${paymentId}`,
          fail: `${api}/v1/payments/bkash/callback/${paymentId}`,
          cancel: `${api}/v1/payments/bkash/callback/${paymentId}`,
          notify: `${api}/v1/payments/bkash/callback/${paymentId}`,
        };
      case 'stripe':
        return {
          success: `${web}/billing/return?org=${orgId}&payment=${paymentId}&status=processing`,
          fail: `${web}/billing/return?org=${orgId}&payment=${paymentId}&status=failed`,
          cancel: `${web}/billing/return?org=${orgId}&payment=${paymentId}&status=canceled`,
          notify: `${api}/v1/payments/stripe/webhook`,
        };
    }
  }

  /** Where the payer's browser lands after a gateway redirect. */
  resultUrl(
    payment: { _id: Types.ObjectId; orgId: Types.ObjectId } | null,
    status: string,
  ): string {
    const web = this.config.get('WEB_APP_URL').replace(/\/$/, '');
    if (!payment) return `${web}/billing/return?status=${encodeURIComponent(status)}`;
    return `${web}/billing/return?org=${payment.orgId.toHexString()}&payment=${payment._id.toHexString()}&status=${encodeURIComponent(status)}`;
  }

  private async checkAmount(amountMinor: number): Promise<void> {
    const { minTopupMinor, maxTopupMinor } = (await this.settings.get()).billing;
    if (amountMinor < minTopupMinor || amountMinor > maxTopupMinor) {
      throw AppError.validation([
        {
          path: 'amountMinor',
          message: `Amount must be between ${minTopupMinor} and ${maxTopupMinor} (minor units)`,
        },
      ]);
    }
  }

  private async payer(): Promise<CheckoutRequest['customer']> {
    const orgId = RequestContext.tenant()!.orgId;
    const actor = RequestContext.actor();
    const [org, user] = await Promise.all([
      this.orgs.findById(orgId, { name: 1, contact: 1 }).lean().exec(),
      actor.type === 'user'
        ? this.users.findById(actor.id, { name: 1, email: 1, phone: 1 }).lean().exec()
        : null,
    ]);
    const phone = org?.contact?.phone ?? (user as { phone?: string } | null)?.phone;
    return {
      name: user?.name ?? org?.name ?? 'Customer',
      ...(user?.email
        ? { email: user.email }
        : org?.contact?.email
          ? { email: org.contact.email }
          : {}),
      ...(phone ? { phone: phone.replace(/^\+880/, '0') } : {}),
    };
  }

  private async startCheckout(input: {
    purpose: Payment['purpose'];
    amountMinor: number;
    gateway: OnlineGateway;
    description: string;
    idempotencyKey?: string;
    plan?: { code: string; interval: BillingInterval };
  }): Promise<PaymentDoc> {
    const orgId = RequestContext.tenant()!.orgId;
    const wallet = await this.wallet.get();
    await this.gateways.require(input.gateway, wallet.currency);
    if (input.idempotencyKey) {
      const prior = await this.payments.findOne({ idempotencyKey: input.idempotencyKey });
      if (prior) return prior;
    }
    let payment: PaymentDoc;
    try {
      payment = await this.payments.create({
        purpose: input.purpose,
        amountMinor: input.amountMinor,
        currency: wallet.currency,
        gateway: input.gateway,
        status: 'pending',
        idempotencyKey: input.idempotencyKey ?? `auto:${randomToken(12)}`,
        ...(input.plan ? { plan: input.plan } : {}),
        createdBy: new Types.ObjectId(RequestContext.actor().id),
        events: [{ at: new Date(), type: 'created', data: {} }],
      });
    } catch (err) {
      if (isDuplicateKey(err) && input.idempotencyKey)
        return (await this.payments.findOne({ idempotencyKey: input.idempotencyKey }))!;
      throw err;
    }
    const request: CheckoutRequest = {
      paymentId: payment._id.toHexString(),
      amountMinor: input.amountMinor,
      currency: wallet.currency,
      description: input.description,
      customer: await this.payer(),
      urls: this.callbackUrls(input.gateway, payment._id.toHexString(), orgId),
    };
    let session: CheckoutSession;
    try {
      session = await this.createSession(input.gateway, wallet.currency, request);
    } catch (err) {
      const reason = err instanceof GatewayError ? err.message : 'gateway_unreachable';
      this.logger.warn(
        { err, gateway: input.gateway, paymentId: request.paymentId },
        'Checkout creation failed',
      );
      await this.payments.updateOne(
        { _id: payment._id },
        {
          $set: { status: 'failed', failureReason: reason },
          $push: {
            events: {
              at: new Date(),
              type: 'checkout_failed',
              data: err instanceof GatewayError ? err.details : {},
            },
          },
        },
      );
      throw new AppError(
        'gateway_error',
        502,
        'The payment provider is not responding. Try again in a minute or use another method.',
      );
    }
    return (await this.payments.findOneAndUpdate(
      { _id: payment._id },
      {
        $set: { gatewaySessionId: session.sessionId, checkoutUrl: session.redirectUrl },
        $push: { events: { at: new Date(), type: 'checkout_created', data: session.raw } },
      },
    ))!;
  }

  private async createSession(
    gateway: OnlineGateway,
    currency: string,
    request: CheckoutRequest,
  ): Promise<CheckoutSession> {
    switch (gateway) {
      case 'sslcommerz': {
        const gw = await this.gateways.require('sslcommerz', currency);
        return this.sslcommerz.createCheckout(gw.credentials, gw.sandbox, request);
      }
      case 'bkash': {
        const gw = await this.gateways.require('bkash', currency);
        return this.bkash.createCheckout(gw.credentials, gw.sandbox, request);
      }
      case 'stripe': {
        const gw = await this.gateways.require('stripe', currency);
        return this.stripe.createCheckout(gw.credentials, request);
      }
    }
  }

  async createTopup(input: {
    amountMinor: number;
    gateway: OnlineGateway;
    idempotencyKey?: string;
  }): Promise<PaymentDoc> {
    await this.checkAmount(input.amountMinor);
    const currency = (await this.wallet.get()).currency;
    return this.startCheckout({
      purpose: 'wallet_topup',
      amountMinor: input.amountMinor,
      gateway: input.gateway,
      description: `Sellora wallet top-up ${formatMoney(input.amountMinor, currency)}`,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  /** Pays for a plan through a gateway: the money lands in the wallet, then buys the plan. */
  async createPlanCheckout(input: {
    planCode: string;
    interval: BillingInterval;
    gateway: OnlineGateway;
    idempotencyKey?: string;
  }): Promise<PaymentDoc> {
    const plan = await this.plans.findByCode(input.planCode);
    if (!plan || !plan.isActive || !plan.isPublic) throw AppError.notFound('plan');
    const currency = (await this.wallet.get()).currency;
    const price = priceFor(plan, input.interval, currency);
    if (!price || price.amountMinor <= 0)
      throw AppError.unprocessable(
        'price_unavailable',
        'This plan cannot be bought with this payment method.',
      );
    return this.startCheckout({
      purpose: 'subscription',
      amountMinor: price.amountMinor,
      gateway: input.gateway,
      description: `Sellora ${plan.name} (${input.interval})`,
      plan: { code: plan.code, interval: input.interval },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  /** The business reports a transfer it made (bKash/Nagad send money, bank deposit). */
  async submitManual(input: {
    amountMinor: number;
    transfer: ManualTransfer;
  }): Promise<PaymentDoc> {
    await this.checkAmount(input.amountMinor);
    const instructions = await this.gateways.manualInstructions();
    if (!instructions)
      throw AppError.unprocessable(
        'gateway_unavailable',
        'Manual payments are not accepted right now.',
      );
    const wallet = await this.wallet.get();
    try {
      const payment = await this.payments.create({
        purpose: 'wallet_topup',
        amountMinor: input.amountMinor,
        currency: wallet.currency,
        gateway: 'manual',
        status: 'pending',
        idempotencyKey: `manual:${input.transfer.method}:${input.transfer.transactionRef}`,
        manual: input.transfer,
        createdBy: new Types.ObjectId(RequestContext.actor().id),
        events: [{ at: new Date(), type: 'submitted', data: {} }],
      });
      await this.audit.record({
        action: 'billing.manual_payment.submitted',
        orgId: RequestContext.tenant()!.orgId,
        target: { type: 'payment', id: payment._id.toHexString() },
        metadata: {
          amountMinor: input.amountMinor,
          method: input.transfer.method,
          transactionRef: input.transfer.transactionRef,
        },
      });
      this.events.emit(MANUAL_PAYMENT_SUBMITTED, {
        orgId: RequestContext.tenant()!.orgId,
        paymentId: payment._id.toHexString(),
        amountMinor: input.amountMinor,
        currency: wallet.currency,
      });
      return payment;
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict(
          'transfer_already_reported',
          'This transaction ID was already submitted.',
        );
      throw err;
    }
  }

  // ---------------------------------------------------------------- completion

  /** Finds a payment from any tenant by id (gateway callbacks carry no tenant). */
  private async locate(
    paymentId: string,
  ): Promise<{ _id: Types.ObjectId; orgId: Types.ObjectId; gateway: GatewayKey } | null> {
    if (!Types.ObjectId.isValid(paymentId)) return null;
    return this.paymentModel
      .findById(paymentId, { orgId: 1, gateway: 1 }, { [CROSS_TENANT]: true })
      .lean()
      .exec();
  }

  /**
   * Applies a gateway-verified result. Credits the wallet once, issues a receipt, and for
   * plan purchases buys the plan from the wallet. Runs in the payment's tenant scope.
   */
  async applyVerified(
    paymentId: string,
    result: VerifiedPayment,
    source: string,
  ): Promise<PaymentDoc | null> {
    const located = await this.locate(paymentId);
    if (!located) {
      this.logger.warn({ paymentId, source }, 'Verified result for an unknown payment');
      return null;
    }
    return RequestContext.withTenant(located.orgId.toHexString(), async () => {
      if (result.status === 'pending') {
        await this.payments.updateOne(
          { _id: located._id },
          { $push: { events: { at: new Date(), type: `${source}:pending`, data: result.raw } } },
        );
        return this.payments.findById(located._id);
      }
      if (result.status === 'failed')
        return this.markFailed(
          located._id,
          result.reason ?? 'failed',
          'failed',
          result.raw,
          source,
        );

      const outcome = await this.tx.run(async () => {
        const payment = (await this.payments.findById(located._id))!;
        if (payment.status === 'succeeded') return { payment, applied: false };
        if (
          result.amountMinor !== payment.amountMinor ||
          (result.currency ?? '').toUpperCase() !== payment.currency
        ) {
          await this.payments.updateOne(
            { _id: payment._id },
            {
              $set: {
                status: 'failed',
                failureReason: 'amount_mismatch',
                gatewayRef: result.gatewayRef,
              },
              $push: {
                events: { at: new Date(), type: `${source}:amount_mismatch`, data: result.raw },
              },
            },
          );
          await this.audit.record({
            action: 'billing.payment.amount_mismatch',
            orgId: payment.orgId,
            outcome: 'failure',
            target: { type: 'payment', id: payment._id.toHexString() },
            metadata: {
              expected: { amountMinor: payment.amountMinor, currency: payment.currency },
              got: { amountMinor: result.amountMinor ?? null, currency: result.currency ?? null },
              gateway: payment.gateway,
            },
          });
          return { payment: (await this.payments.findById(payment._id))!, applied: false };
        }
        const updated = await this.payments.findOneAndUpdate(
          { _id: payment._id, status: { $ne: 'succeeded' } },
          {
            $set: {
              status: 'succeeded',
              succeededAt: new Date(),
              ...(result.gatewayRef ? { gatewayRef: result.gatewayRef } : {}),
            },
            $unset: { failureReason: 1 },
            $push: { events: { at: new Date(), type: `${source}:succeeded`, data: result.raw } },
          },
        );
        if (!updated)
          return { payment: (await this.payments.findById(payment._id))!, applied: false };
        await this.wallet.credit({
          type: 'topup',
          amountMinor: payment.amountMinor,
          idempotencyKey: `payment:${payment._id.toHexString()}`,
          description:
            payment.purpose === 'subscription'
              ? `Payment for ${payment.plan?.code ?? 'plan'} via ${payment.gateway}`
              : `Top-up via ${payment.gateway}`,
          reference: { type: 'payment', id: payment._id.toHexString() },
          actor: { type: 'system', id: `gateway:${payment.gateway}` },
        });
        if (payment.purpose === 'wallet_topup') {
          await this.invoices.issue({
            kind: 'wallet_topup',
            currency: payment.currency,
            lines: [{ description: 'Wallet top-up', quantity: 1, unitMinor: payment.amountMinor }],
            paidWith: payment.gateway,
            paymentId: payment._id,
          });
        }
        await this.audit.record({
          action: 'billing.payment.succeeded',
          orgId: payment.orgId,
          target: { type: 'payment', id: payment._id.toHexString() },
          metadata: {
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            gateway: payment.gateway,
            gatewayRef: result.gatewayRef ?? null,
            source,
          },
        });
        return { payment: updated, applied: true };
      });

      if (outcome.applied) {
        this.events.emit(PAYMENT_SUCCEEDED, {
          orgId: located.orgId.toHexString(),
          paymentId,
          amountMinor: outcome.payment.amountMinor,
          currency: outcome.payment.currency,
        });
        if (outcome.payment.purpose === 'subscription' && outcome.payment.plan) {
          try {
            await this.subscriptions.subscribe(
              outcome.payment.plan.code,
              outcome.payment.plan.interval,
            );
          } catch (err) {
            // The money is safe in the wallet; the merchant can pick the plan from there.
            this.logger.error({ err, paymentId }, 'Paid for a plan but could not switch it');
          }
        }
      }
      return outcome.payment;
    });
  }

  private async markFailed(
    id: Types.ObjectId,
    reason: string,
    status: 'failed' | 'canceled',
    raw: Record<string, unknown>,
    source: string,
  ): Promise<PaymentDoc | null> {
    await this.payments.updateOne(
      { _id: id, status: 'pending' },
      {
        $set: { status, failureReason: reason },
        $push: { events: { at: new Date(), type: `${source}:${status}`, data: raw } },
      },
    );
    return this.payments.findById(id);
  }

  // ---------------------------------------------------------------- gateway callbacks

  async handleSslcommerzReturn(
    paymentId: string,
    outcome: 'success' | 'fail' | 'cancel',
    body: Record<string, unknown>,
  ): Promise<string> {
    const located = await this.locate(paymentId);
    if (!located || located.gateway !== 'sslcommerz') return this.resultUrl(null, 'unknown');
    if (outcome === 'success') {
      // Without a val_id there is nothing to verify; the IPN will settle it.
      const payment =
        typeof body.val_id === 'string'
          ? await this.verifySslcommerz(body.val_id, paymentId, 'return')
          : null;
      return this.resultUrl(located, payment?.status ?? 'processing');
    }
    // The browser saying "failed" is not proof of anything; it only closes a still-pending payment.
    await RequestContext.withTenant(located.orgId.toHexString(), () =>
      this.markFailed(
        located._id,
        outcome === 'cancel' ? 'canceled_by_payer' : 'sslcommerz_failed',
        outcome === 'cancel' ? 'canceled' : 'failed',
        {},
        'return',
      ),
    );
    return this.resultUrl(located, outcome === 'cancel' ? 'canceled' : 'failed');
  }

  async handleSslcommerzIpn(body: Record<string, unknown>): Promise<void> {
    const tranId = typeof body.tran_id === 'string' ? body.tran_id : null;
    if (!tranId) return;
    if (typeof body.val_id === 'string') await this.verifySslcommerz(body.val_id, tranId, 'ipn');
  }

  private async verifySslcommerz(
    valId: string,
    paymentId: string,
    source: string,
  ): Promise<PaymentDoc | null> {
    const gw = await this.gateways.get('sslcommerz');
    if (!gw) return null;
    const verified = await this.sslcommerz.validate(gw.credentials, gw.sandbox, valId);
    if (verified.tranId && verified.tranId !== paymentId) {
      this.logger.warn(
        { paymentId, tranId: verified.tranId },
        'SSLCommerz val_id belongs to another transaction',
      );
      return null;
    }
    return this.applyVerified(paymentId, verified, `sslcommerz:${source}`);
  }

  async handleBkashCallback(
    paymentId: string,
    query: { paymentID?: string; status?: string },
  ): Promise<string> {
    const located = await this.locate(paymentId);
    if (!located || located.gateway !== 'bkash') return this.resultUrl(null, 'unknown');
    if (query.status !== 'success' || !query.paymentID) {
      await RequestContext.withTenant(located.orgId.toHexString(), () =>
        this.markFailed(
          located._id,
          query.status === 'cancel' ? 'canceled_by_payer' : 'bkash_failed',
          query.status === 'cancel' ? 'canceled' : 'failed',
          { status: query.status ?? null },
          'callback',
        ),
      );
      return this.resultUrl(located, query.status === 'cancel' ? 'canceled' : 'failed');
    }
    const session = await this.paymentModel
      .findById(located._id, { gatewaySessionId: 1 }, { [CROSS_TENANT]: true })
      .lean()
      .exec();
    if (session?.gatewaySessionId !== query.paymentID) return this.resultUrl(located, 'failed');
    const gw = await this.gateways.get('bkash');
    if (!gw) return this.resultUrl(located, 'failed');
    const verified = await this.bkash.execute(gw.credentials, gw.sandbox, query.paymentID);
    if (verified.invoice && verified.invoice !== paymentId)
      return this.resultUrl(located, 'failed');
    const payment = await this.applyVerified(paymentId, verified, 'bkash:execute');
    return this.resultUrl(located, payment?.status ?? 'processing');
  }

  async handleStripeWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{ received: boolean }> {
    const gw = await this.gateways.get('stripe');
    if (!gw) throw AppError.notFound('gateway');
    if (!rawBody) throw AppError.badRequest('malformed_body', 'Missing body');
    let event;
    try {
      event = this.stripe.verifyWebhook(rawBody, signature, gw.credentials.webhookSecret);
    } catch (err) {
      if (err instanceof GatewayError) throw AppError.badRequest('invalid_signature', err.message);
      throw err;
    }
    const parsed = this.stripe.fromCheckoutEvent(event);
    if (parsed?.paymentId)
      await this.applyVerified(parsed.paymentId, parsed.result, 'stripe:webhook');
    return { received: true };
  }

  // ---------------------------------------------------------------- platform review

  async listForPlatform(q: {
    status?: Payment['status'];
    gateway?: GatewayKey;
    orgId?: string;
    limit: number;
    before?: string;
  }) {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.gateway) filter.gateway = q.gateway;
    if (q.orgId) filter.orgId = new Types.ObjectId(q.orgId);
    if (q.before && Types.ObjectId.isValid(q.before))
      filter._id = { $lt: new Types.ObjectId(q.before) };
    const docs = await this.paymentModel
      .find(filter, null, { [CROSS_TENANT]: true })
      .sort({ _id: -1 })
      .limit(q.limit + 1)
      .lean<PaymentDoc[]>()
      .exec();
    const items = docs.slice(0, q.limit);
    return {
      items: items.map(toPlatformPaymentDto),
      nextCursor: docs.length > q.limit ? items[items.length - 1]!._id.toHexString() : null,
    };
  }

  async reviewManual(
    paymentId: string,
    decision: 'approve' | 'reject',
    note: string,
    actorId: string,
  ): Promise<PaymentDoc> {
    const located = await this.locate(paymentId);
    if (!located) throw AppError.notFound('payment');
    if (located.gateway !== 'manual')
      throw AppError.unprocessable('not_manual', 'Only manual payments are reviewed here.');
    return RequestContext.withTenant(
      located.orgId.toHexString(),
      async () => {
        const payment = (await this.payments.findById(located._id))!;
        if (payment.status !== 'pending')
          throw AppError.conflict('already_reviewed', `This payment is already ${payment.status}.`);
        await this.payments.updateOne(
          { _id: payment._id },
          { $set: { reviewedBy: actorId, reviewNote: note } },
        );
        if (decision === 'reject') {
          const rejected = await this.markFailed(
            payment._id,
            'rejected_by_platform',
            'failed',
            { note },
            'platform',
          );
          await this.audit.record({
            action: 'platform.manual_payment.rejected',
            orgId: payment.orgId,
            target: { type: 'payment', id: paymentId },
            metadata: { note },
          });
          return rejected!;
        }
        const approved = await this.applyVerified(
          paymentId,
          {
            status: 'succeeded',
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            gatewayRef: payment.manual?.transactionRef ?? paymentId,
            raw: { reviewedBy: actorId },
          },
          'platform',
        );
        await this.audit.record({
          action: 'platform.manual_payment.approved',
          orgId: payment.orgId,
          target: { type: 'payment', id: paymentId },
          metadata: { note, amountMinor: payment.amountMinor },
        });
        return approved!;
      },
      { type: 'platform', id: actorId },
    );
  }

  // ---------------------------------------------------------------- merchant reads

  list(q: { limit: number; cursor?: string }) {
    return this.payments.paginate({}, q);
  }

  async get(id: string): Promise<PaymentDoc> {
    const payment = await this.payments.findById(id);
    if (!payment) throw AppError.notFound('payment');
    return payment;
  }
}
