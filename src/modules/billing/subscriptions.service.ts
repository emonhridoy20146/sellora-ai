import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { mulDiv } from '../../common/money/money.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ORG_CREATED, type OrgCreatedEvent } from '../orgs/orgs.service.js';
import type { Organization } from '../orgs/schemas.js';
import { PlatformSettingsService } from '../platform/platform-settings.service.js';
import { FREE_PLAN_CODE } from './billing-defaults.js';
import { CreditsService } from './credits.service.js';
import { EntitlementsService, type Entitlements } from './entitlements.service.js';
import type { BillingInterval, FeatureModule, PlanLimits } from './feature-modules.js';
import { InvoicesService } from './invoices.service.js';
import { PlansService, priceFor, type PlanDoc } from './plans.service.js';
import type { EntitlementOverrides, Subscription } from './schemas.js';
import { WalletService } from './wallet.service.js';

export type SubscriptionDoc = WithId<Subscription>;

export const SUBSCRIPTION_CHANGED = 'billing.subscription_changed';
export const SUBSCRIPTION_PAST_DUE = 'billing.subscription_past_due';

const DAY_MS = 24 * 3600_000;

@Injectable()
export class SubscriptionRepository extends TenantScopedRepository<Subscription> {
  constructor(@InjectModel('Subscription') model: Model<Subscription>) {
    super(model);
  }
}

/** Adds calendar months, clamping to the last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export function periodEnd(start: Date, interval: BillingInterval): Date | undefined {
  if (interval === 'lifetime') return undefined;
  return addMonths(start, interval === 'year' ? 12 : 1);
}

export function toSubscriptionDto(sub: SubscriptionDoc, ent: Entitlements) {
  return {
    plan: { code: sub.planCode, name: sub.planName },
    status: sub.status,
    interval: sub.interval,
    currency: sub.currency,
    priceMinor: sub.priceMinor,
    currentPeriodStart: sub.currentPeriodStart.toISOString(),
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    autoRenew: sub.autoRenew,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    includedCreditsPerMonth: sub.includedCreditsPerMonth,
    nextCreditGrantAt: sub.nextCreditGrantAt?.toISOString() ?? null,
    entitlements: {
      planCode: ent.planCode,
      paidAccess: ent.paidAccess,
      inGracePeriod: ent.inGracePeriod,
      modules: ent.modules,
      limits: ent.limits,
    },
  };
}

/** Splits fields into $set and $unset so `undefined` clears a field instead of being cast. */
function setFields(fields: Record<string, unknown>, unset: Record<string, 1> = {}) {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = { ...unset };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) $unset[k] = 1;
    else $set[k] = v;
  }
  for (const k of Object.keys($set)) delete $unset[k];
  return Object.keys($unset).length ? { $set, $unset } : { $set };
}

function snapshotOf(plan: PlanDoc) {
  return {
    planId: plan._id,
    planCode: plan.code,
    planName: plan.name,
    planVersion: plan.version,
    modules: plan.modules,
    limits: plan.limits,
    includedCreditsPerMonth: plan.includedCreditsPerMonth,
  };
}

/**
 * The business's plan over time: trial on sign-up, paying from the wallet, renewals,
 * cancellations, falling back to the free plan, and super-admin grants. All money moves
 * through WalletService in the same transaction as the subscription change.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly subs: SubscriptionRepository,
    @InjectModel('Subscription') private readonly subModel: Model<Subscription>,
    @InjectModel('Organization') private readonly orgs: Model<Organization>,
    private readonly plans: PlansService,
    private readonly wallet: WalletService,
    private readonly credits: CreditsService,
    private readonly invoices: InvoicesService,
    private readonly entitlements: EntitlementsService,
    private readonly settings: PlatformSettingsService,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private async changed(sub: SubscriptionDoc | null, reason: string): Promise<void> {
    const orgId = this.orgId();
    await this.entitlements.invalidate(orgId);
    this.events.emit(SUBSCRIPTION_CHANGED, {
      orgId,
      reason,
      planCode: sub?.planCode ?? null,
      status: sub?.status ?? null,
    });
  }

  // ---------------------------------------------------------------- start

  @OnEvent(ORG_CREATED)
  async onOrgCreated(event: OrgCreatedEvent): Promise<void> {
    try {
      await RequestContext.withTenant(event.orgId, () => this.start(event.isDemo), {
        type: 'system',
        id: 'billing',
      });
    } catch (err) {
      // Never fail business creation; get() creates the subscription lazily later.
      this.logger.error({ err, orgId: event.orgId }, 'Could not start the initial subscription');
    }
  }

  /** Creates the first subscription: a trial of the configured plan, or the free plan. */
  async start(isDemo = false): Promise<SubscriptionDoc> {
    const existing = await this.subs.findOne({});
    if (existing) return existing;
    const settings = await this.settings.get();
    const org = await this.orgs
      .findById(this.orgId(), { currency: 1, demoExpiresAt: 1 })
      .lean()
      .exec();
    const currency = org?.currency ?? 'BDT';
    const now = new Date();
    const trialPlan =
      settings.trial.enabled || isDemo
        ? await this.plans.findByCode(settings.trial.planCode)
        : null;
    const trialEnds =
      isDemo && org?.demoExpiresAt
        ? org.demoExpiresAt
        : new Date(now.getTime() + settings.trial.days * DAY_MS);

    let doc: Omit<Subscription, 'orgId'>;
    if (trialPlan?.isActive && trialEnds > now) {
      doc = {
        ...snapshotOf(trialPlan),
        status: 'trialing',
        interval: 'trial',
        currency,
        priceMinor: 0,
        currentPeriodStart: now,
        currentPeriodEnd: trialEnds,
        trialEndsAt: trialEnds,
        autoRenew: false,
        cancelAtPeriodEnd: false,
        source: 'trial',
        overrides: { addModules: [], removeModules: [], limits: {} },
        nextCreditGrantAt: now,
      };
    } else {
      const free = await this.plans.findByCode(FREE_PLAN_CODE);
      if (!free) throw AppError.unprocessable('no_free_plan', 'No free plan is configured.');
      doc = {
        ...snapshotOf(free),
        status: 'active',
        interval: 'month',
        currency,
        priceMinor: 0,
        currentPeriodStart: now,
        autoRenew: false,
        cancelAtPeriodEnd: false,
        source: 'free',
        overrides: { addModules: [], removeModules: [], limits: {} },
        nextCreditGrantAt: now,
      };
    }
    let created: SubscriptionDoc;
    try {
      created = await this.subs.create(doc);
    } catch (err) {
      if (isDuplicateKey(err)) return (await this.subs.findOne({}))!;
      throw err;
    }
    await this.audit.record({
      action: 'billing.subscription.started',
      orgId: this.orgId(),
      target: { type: 'subscription', id: created._id.toHexString(), label: created.planCode },
      metadata: { status: created.status, trialEndsAt: created.trialEndsAt ?? null },
    });
    await this.grantIncludedCredits(created);
    await this.changed(created, 'started');
    return (await this.subs.findById(created._id))!;
  }

  async get(): Promise<SubscriptionDoc> {
    return (await this.subs.findOne({})) ?? this.start();
  }

  async view() {
    const sub = await this.get();
    return toSubscriptionDto(sub, await this.entitlements.forOrg(this.orgId()));
  }

  // ---------------------------------------------------------------- included credits

  /**
   * Grants the plan's monthly included credits as bonus (never withdrawable). Leftover
   * included credit from the previous grant expires first, so free credit does not pile up.
   */
  async grantIncludedCredits(sub: SubscriptionDoc, now = new Date()): Promise<void> {
    if (!sub.nextCreditGrantAt || sub.nextCreditGrantAt > now) return;
    const due = sub.nextCreditGrantAt;
    // A trial gets one grant; paid and free plans get one per calendar month.
    const next = sub.status === 'trialing' ? undefined : addMonths(due, 1);
    const eligible = sub.status === 'active' || sub.status === 'trialing';
    await this.tx.run(async () => {
      const claimed = await this.subs.findOneAndUpdate(
        { _id: sub._id, nextCreditGrantAt: due },
        setFields({ nextCreditGrantAt: next }),
      );
      if (!claimed) return;
      const wallet = await this.wallet.get();
      const leftover = Math.min(wallet.bonusMinor, sub.lastCreditGrant?.amountMinor ?? 0);
      if (leftover > 0) {
        await this.wallet.debit({
          type: 'bonus',
          amountMinor: leftover,
          allowFrozen: true,
          idempotencyKey: `included-expire:${sub._id.toHexString()}:${due.getTime()}`,
          description: 'Unused included AI credits expired',
          actor: { type: 'system', id: 'billing' },
        });
      }
      if (!eligible || sub.includedCreditsPerMonth <= 0) {
        if (sub.lastCreditGrant)
          await this.subs.updateOne({ _id: sub._id }, { $unset: { lastCreditGrant: 1 } });
        return;
      }
      const rate = await this.credits.currentRate(wallet.currency);
      const amountMinor = sub.includedCreditsPerMonth * rate.creditPriceMinor;
      await this.wallet.credit({
        type: 'bonus',
        amountMinor,
        credits: sub.includedCreditsPerMonth,
        idempotencyKey: `included:${sub._id.toHexString()}:${due.getTime()}`,
        description: `${sub.includedCreditsPerMonth} AI credits included with ${sub.planName}`,
        reference: { type: 'subscription', id: sub._id.toHexString() },
        actor: { type: 'system', id: 'billing' },
      });
      await this.subs.updateOne(
        { _id: sub._id },
        { $set: { lastCreditGrant: { amountMinor, at: now } } },
      );
    });
  }

  // ---------------------------------------------------------------- merchant changes

  /** Buys or switches plan, paying from the wallet. Unused paid time is refunded pro rata. */
  async subscribe(planCode: string, interval: BillingInterval): Promise<SubscriptionDoc> {
    const plan = await this.plans.findByCode(planCode);
    if (!plan || !plan.isActive || !plan.isPublic) throw AppError.notFound('plan');
    await this.get();
    const now = new Date();
    const result = await this.tx.run(async () => {
      const current = (await this.subs.findOne({}))!;
      const price = priceFor(plan, interval, current.currency);
      if (!price)
        throw AppError.unprocessable(
          'price_unavailable',
          `${plan.name} is not sold ${interval === 'lifetime' ? 'as lifetime' : `${interval}ly`} in ${current.currency}.`,
        );
      const running =
        current.status === 'active' &&
        (!current.currentPeriodEnd || current.currentPeriodEnd > now);
      if (
        running &&
        current.planCode === plan.code &&
        current.interval === interval &&
        current.source !== 'free'
      ) {
        throw AppError.conflict('already_subscribed', `You are already on ${plan.name}.`);
      }
      const stateKey = `${current._id.toHexString()}:${current.currentPeriodStart.getTime()}`;

      let refundMinor = 0;
      if (
        running &&
        (current.source === 'wallet' || current.source === 'gateway') &&
        current.priceMinor > 0 &&
        current.currentPeriodEnd
      ) {
        const total = current.currentPeriodEnd.getTime() - current.currentPeriodStart.getTime();
        const remaining = current.currentPeriodEnd.getTime() - now.getTime();
        refundMinor =
          total > 0
            ? Math.min(current.priceMinor, mulDiv(current.priceMinor, remaining, total))
            : 0;
      }
      if (refundMinor > 0) {
        await this.wallet.credit({
          type: 'refund',
          amountMinor: refundMinor,
          idempotencyKey: `proration:${stateKey}`,
          description: `Unused time on ${current.planName}`,
          reference: { type: 'subscription', id: current._id.toHexString() },
        });
      }
      if (price.amountMinor > 0) {
        await this.wallet.debit({
          type: 'subscription',
          amountMinor: price.amountMinor,
          idempotencyKey: `subscribe:${stateKey}:${plan.code}:${interval}`,
          description: `${plan.name} (${interval})`,
          reference: { type: 'plan', id: plan.code },
        });
      }
      const updated = await this.subs.findOneAndUpdate(
        { _id: current._id, currentPeriodStart: current.currentPeriodStart },
        setFields(
          {
            ...snapshotOf(plan),
            status: 'active',
            interval,
            priceMinor: price.amountMinor,
            currentPeriodStart: now,
            currentPeriodEnd: price.amountMinor > 0 ? periodEnd(now, interval) : undefined,
            autoRenew: interval !== 'lifetime' && price.amountMinor > 0,
            cancelAtPeriodEnd: false,
            source: price.amountMinor > 0 ? 'wallet' : 'free',
            nextCreditGrantAt: now,
          },
          { trialEndsAt: 1, pastDueSince: 1, canceledAt: 1 },
        ),
      );
      if (!updated)
        throw AppError.conflict(
          'subscription_changed',
          'Your plan changed in the meantime. Refresh and try again.',
        );
      if (price.amountMinor > 0) {
        await this.invoices.issue({
          kind: 'subscription',
          currency: current.currency,
          lines: [
            {
              description: `${plan.name} — ${interval === 'lifetime' ? 'lifetime' : `1 ${interval}`}`,
              quantity: 1,
              unitMinor: price.amountMinor,
            },
          ],
          paidWith: 'wallet',
        });
      }
      await this.audit.record({
        action: 'billing.subscription.changed',
        orgId: this.orgId(),
        target: { type: 'subscription', id: current._id.toHexString(), label: plan.code },
        metadata: {
          from: { plan: current.planCode, interval: current.interval, status: current.status },
          to: { plan: plan.code, interval },
          chargedMinor: price.amountMinor,
          refundMinor,
        },
      });
      return updated;
    });
    await this.grantIncludedCredits(result);
    await this.changed(result, 'subscribed');
    return (await this.subs.findById(result._id))!;
  }

  async cancel(): Promise<SubscriptionDoc> {
    const sub = await this.get();
    if (sub.source === 'free' || sub.status === 'trialing' || !sub.currentPeriodEnd) {
      throw AppError.conflict('not_cancelable', 'There is no paid renewal to cancel.');
    }
    const updated = await this.subs.findOneAndUpdate(
      { _id: sub._id },
      { $set: { cancelAtPeriodEnd: true, autoRenew: false, canceledAt: new Date() } },
    );
    await this.audit.record({
      action: 'billing.subscription.canceled',
      orgId: this.orgId(),
      target: { type: 'subscription', id: sub._id.toHexString(), label: sub.planCode },
      metadata: { endsAt: sub.currentPeriodEnd },
    });
    await this.changed(updated, 'canceled');
    return updated!;
  }

  async resume(): Promise<SubscriptionDoc> {
    const sub = await this.get();
    if (!sub.cancelAtPeriodEnd || !sub.currentPeriodEnd || sub.currentPeriodEnd <= new Date()) {
      throw AppError.conflict('not_resumable', 'This plan is not scheduled to end.');
    }
    const updated = await this.subs.findOneAndUpdate(
      { _id: sub._id },
      { $set: { cancelAtPeriodEnd: false, autoRenew: true }, $unset: { canceledAt: 1 } },
    );
    await this.audit.record({
      action: 'billing.subscription.resumed',
      orgId: this.orgId(),
      target: { type: 'subscription', id: sub._id.toHexString(), label: sub.planCode },
    });
    await this.changed(updated, 'resumed');
    return updated!;
  }

  // ---------------------------------------------------------------- renewals (worker)

  /** Subscriptions whose trial or period has ended, across all businesses. */
  async findDue(now: Date, limit = 200): Promise<{ id: string; orgId: string }[]> {
    const docs = await this.subModel
      .find(
        {
          $or: [
            { status: { $in: ['active', 'past_due'] }, currentPeriodEnd: { $lte: now } },
            { status: 'trialing', trialEndsAt: { $lte: now } },
          ],
        },
        { orgId: 1 },
        { [CROSS_TENANT]: true },
      )
      .limit(limit)
      .lean()
      .exec();
    return docs.map((d) => ({ id: d._id.toHexString(), orgId: d.orgId.toHexString() }));
  }

  async findCreditGrantsDue(now: Date, limit = 500): Promise<{ id: string; orgId: string }[]> {
    const docs = await this.subModel
      .find(
        { nextCreditGrantAt: { $lte: now }, status: { $in: ['active', 'trialing'] } },
        { orgId: 1 },
        { [CROSS_TENANT]: true },
      )
      .limit(limit)
      .lean()
      .exec();
    return docs.map((d) => ({ id: d._id.toHexString(), orgId: d.orgId.toHexString() }));
  }

  /** Grants included credits if due. Runs inside the business's tenant scope. */
  async grantDue(subId: string, now = new Date()): Promise<void> {
    const sub = await this.subs.findById(subId);
    if (sub) await this.grantIncludedCredits(sub, now);
  }

  /** Runs inside the business's tenant scope. Returns what happened. */
  async renew(
    subId: string,
    now = new Date(),
  ): Promise<'renewed' | 'past_due' | 'downgraded' | 'skipped'> {
    const sub = await this.subs.findById(subId);
    if (!sub) return 'skipped';
    if (sub.status === 'trialing') {
      if (!sub.trialEndsAt || sub.trialEndsAt > now) return 'skipped';
      await this.toFree(sub, 'trial_ended');
      return 'downgraded';
    }
    if (!sub.currentPeriodEnd || sub.currentPeriodEnd > now) return 'skipped';
    if (sub.status !== 'active' && sub.status !== 'past_due') return 'skipped';
    if (sub.cancelAtPeriodEnd || !sub.autoRenew || sub.priceMinor <= 0) {
      await this.toFree(sub, sub.cancelAtPeriodEnd ? 'canceled' : 'period_ended');
      return 'downgraded';
    }
    const { graceDays } = (await this.settings.get()).billing;
    const periodEndAt = sub.currentPeriodEnd;
    const interval = sub.interval === 'year' ? 'year' : 'month';
    // If the job was down past the grace window, start the new period now instead of back-billing.
    const start = now.getTime() - periodEndAt.getTime() > graceDays * DAY_MS ? now : periodEndAt;
    try {
      const renewed = await this.tx.run(async () => {
        await this.wallet.debit({
          type: 'subscription',
          amountMinor: sub.priceMinor,
          idempotencyKey: `renew:${sub._id.toHexString()}:${periodEndAt.getTime()}`,
          description: `${sub.planName} renewal (${interval})`,
          reference: { type: 'subscription', id: sub._id.toHexString() },
          actor: { type: 'system', id: 'billing' },
        });
        const updated = await this.subs.findOneAndUpdate(
          { _id: sub._id, currentPeriodEnd: periodEndAt },
          {
            $set: {
              status: 'active',
              currentPeriodStart: start,
              currentPeriodEnd: periodEnd(start, interval),
            },
            $unset: { pastDueSince: 1 },
          },
        );
        if (!updated)
          throw AppError.conflict('subscription_changed', 'Subscription changed during renewal');
        await this.invoices.issue({
          kind: 'subscription',
          currency: sub.currency,
          lines: [
            {
              description: `${sub.planName} — renewal, 1 ${interval}`,
              quantity: 1,
              unitMinor: sub.priceMinor,
            },
          ],
          paidWith: 'wallet',
        });
        await this.audit.record({
          action: 'billing.subscription.renewed',
          orgId: this.orgId(),
          target: { type: 'subscription', id: sub._id.toHexString(), label: sub.planCode },
          metadata: { chargedMinor: sub.priceMinor },
        });
        return updated;
      });
      await this.changed(renewed, 'renewed');
      return 'renewed';
    } catch (err) {
      if (
        !(err instanceof AppError) ||
        (err.code !== 'insufficient_balance' && err.code !== 'wallet_frozen')
      )
        throw err;
      if (now.getTime() - periodEndAt.getTime() >= graceDays * DAY_MS) {
        await this.toFree(sub, 'payment_failed');
        return 'downgraded';
      }
      if (sub.status !== 'past_due') {
        const updated = await this.subs.findOneAndUpdate(
          { _id: sub._id },
          { $set: { status: 'past_due', pastDueSince: now } },
        );
        await this.audit.record({
          action: 'billing.subscription.past_due',
          orgId: this.orgId(),
          outcome: 'failure',
          target: { type: 'subscription', id: sub._id.toHexString(), label: sub.planCode },
          metadata: { reason: err.code, amountMinor: sub.priceMinor },
        });
        this.events.emit(SUBSCRIPTION_PAST_DUE, {
          orgId: this.orgId(),
          planCode: sub.planCode,
          amountMinor: sub.priceMinor,
          currency: sub.currency,
        });
        await this.changed(updated, 'past_due');
      }
      return 'past_due';
    }
  }

  private async toFree(sub: SubscriptionDoc, reason: string): Promise<void> {
    const free = await this.plans.findByCode(FREE_PLAN_CODE);
    const now = new Date();
    const update = free?.isActive
      ? setFields(
          {
            ...snapshotOf(free),
            status: 'active',
            interval: 'month',
            priceMinor: 0,
            currentPeriodStart: now,
            autoRenew: false,
            cancelAtPeriodEnd: false,
            source: 'free',
            nextCreditGrantAt: now,
          },
          { currentPeriodEnd: 1, trialEndsAt: 1, pastDueSince: 1, canceledAt: 1 },
        )
      : { $set: { status: 'expired', nextCreditGrantAt: now } };
    const updated = await this.subs.findOneAndUpdate({ _id: sub._id }, update);
    await this.audit.record({
      action: 'billing.subscription.downgraded',
      orgId: this.orgId(),
      target: { type: 'subscription', id: sub._id.toHexString(), label: sub.planCode },
      metadata: { reason, from: sub.planCode, to: free?.isActive ? free.code : null },
    });
    if (updated) await this.grantIncludedCredits(updated);
    await this.changed(updated, reason);
  }

  // ---------------------------------------------------------------- platform actions

  /** Gives a business a plan without payment (sales deals, partners, support). */
  async assignPlan(input: {
    planCode: string;
    interval: BillingInterval;
    periodEnd?: Date;
    note: string;
  }): Promise<SubscriptionDoc> {
    const plan = await this.plans.getByCode(input.planCode);
    const sub = await this.get();
    const now = new Date();
    const end = input.periodEnd ?? periodEnd(now, input.interval);
    const updated = await this.subs.findOneAndUpdate(
      { _id: sub._id },
      setFields(
        {
          ...snapshotOf(plan),
          status: 'active',
          interval: input.interval,
          priceMinor: 0,
          currentPeriodStart: now,
          currentPeriodEnd: end,
          autoRenew: false,
          cancelAtPeriodEnd: false,
          source: 'platform',
          nextCreditGrantAt: now,
        },
        { trialEndsAt: 1, pastDueSince: 1, canceledAt: 1 },
      ),
    );
    await this.audit.record({
      action: 'platform.subscription.assigned',
      orgId: this.orgId(),
      target: { type: 'subscription', id: sub._id.toHexString(), label: plan.code },
      metadata: {
        from: sub.planCode,
        to: plan.code,
        interval: input.interval,
        periodEnd: end ?? null,
        note: input.note,
      },
    });
    await this.grantIncludedCredits(updated!);
    await this.changed(updated, 'assigned');
    return (await this.subs.findById(sub._id))!;
  }

  /** Extends a running trial, or starts a new one for a business on the free plan. */
  async extendTrial(days: number, note: string): Promise<SubscriptionDoc> {
    const sub = await this.get();
    const now = new Date();
    let update: Record<string, unknown>;
    if (sub.status === 'trialing') {
      const from = sub.trialEndsAt && sub.trialEndsAt > now ? sub.trialEndsAt : now;
      const ends = new Date(from.getTime() + days * DAY_MS);
      update = { $set: { trialEndsAt: ends, currentPeriodEnd: ends } };
    } else if (sub.source === 'free') {
      const settings = await this.settings.get();
      const plan = await this.plans.getByCode(settings.trial.planCode);
      const ends = new Date(now.getTime() + days * DAY_MS);
      update = {
        $set: {
          ...snapshotOf(plan),
          status: 'trialing',
          interval: 'trial',
          priceMinor: 0,
          currentPeriodStart: now,
          currentPeriodEnd: ends,
          trialEndsAt: ends,
          source: 'trial',
          autoRenew: false,
        },
      };
    } else {
      throw AppError.conflict(
        'not_trialing',
        'This business is on a paid plan. Assign a plan instead.',
      );
    }
    const updated = await this.subs.findOneAndUpdate({ _id: sub._id }, update);
    await this.audit.record({
      action: 'platform.subscription.trial_extended',
      orgId: this.orgId(),
      target: { type: 'subscription', id: sub._id.toHexString(), label: updated!.planCode },
      metadata: { days, trialEndsAt: updated!.trialEndsAt, note },
    });
    await this.changed(updated, 'trial_extended');
    return updated!;
  }

  async setOverrides(input: {
    addModules: FeatureModule[];
    removeModules: FeatureModule[];
    limits: Partial<PlanLimits>;
    expiresAt?: Date;
    note: string;
  }): Promise<SubscriptionDoc> {
    const sub = await this.get();
    const overrides: EntitlementOverrides = {
      addModules: input.addModules,
      removeModules: input.removeModules,
      limits: input.limits,
      note: input.note,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    const updated = await this.subs.findOneAndUpdate({ _id: sub._id }, { $set: { overrides } });
    await this.audit.record({
      action: 'platform.subscription.overrides_set',
      orgId: this.orgId(),
      target: { type: 'subscription', id: sub._id.toHexString(), label: sub.planCode },
      metadata: { before: sub.overrides, after: overrides },
    });
    await this.changed(updated, 'overrides');
    return updated!;
  }

  static objectId(id: string): Types.ObjectId {
    return new Types.ObjectId(id);
  }
}
