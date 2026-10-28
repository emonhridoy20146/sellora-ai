import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model, type PipelineStage } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { AuditService } from '../audit/audit.service.js';
import type { Organization } from '../orgs/schemas.js';
import { CreditsService, type AiUsageDoc } from './credits.service.js';
import type { AiUsage } from './credit-schemas.js';
import { EntitlementsService } from './entitlements.service.js';
import type { Payment, Withdrawal } from './payment-schemas.js';
import type { LedgerType, Subscription, Wallet } from './schemas.js';
import { SubscriptionsService, toSubscriptionDto } from './subscriptions.service.js';
import { WalletService, toBalance } from './wallet.service.js';

export type ProfitGroupBy = 'day' | 'org' | 'model' | 'feature' | 'tier';

interface ProfitRow {
  key: string;
  currency: string;
  requests: number;
  credits: number;
  billedMinor: number;
  collectedMinor: number;
  costMinor: number;
  costUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
}

function withMargin<T extends { collectedMinor: number; costMinor: number }>(row: T) {
  const profitMinor = row.collectedMinor - row.costMinor;
  return {
    ...row,
    profitMinor,
    marginPct:
      row.collectedMinor > 0 ? Math.round((profitMinor / row.collectedMinor) * 10_000) / 100 : null,
  };
}

/** Platform-only usage DTO: includes provider, model and real cost. */
export function toPlatformUsageDto(u: AiUsageDoc) {
  return {
    id: u._id.toHexString(),
    orgId: u.orgId.toHexString(),
    requestId: u.requestId,
    feature: u.feature,
    tier: u.tier,
    status: u.status,
    provider: u.provider ?? null,
    model: u.model ?? null,
    tokens: {
      input: u.inputTokens,
      cachedInput: u.cachedInputTokens,
      cacheWrite: u.cacheWriteInputTokens ?? 0,
      output: u.outputTokens,
    },
    credits: u.credits,
    currency: u.currency,
    billedMinor: u.billedMinor,
    shortfallMinor: u.shortfallMinor,
    costUsdMicros: u.costUsdMicros,
    costMinor: u.costMinor,
    profitMinor: u.billedMinor - u.shortfallMinor - u.costMinor,
    creditRateVersion: u.creditRateVersion,
    at: u.createdAt.toISOString(),
  };
}

/**
 * The super-admin's view of the money: revenue, wallets, AI billed vs real cost (profit),
 * and per-business billing controls. Everything here is cross-tenant by design and only
 * reachable through platform routes.
 */
@Injectable()
export class PlatformBillingService {
  constructor(
    @InjectModel('AiUsage') private readonly usage: Model<AiUsage>,
    @InjectModel('Subscription') private readonly subs: Model<Subscription>,
    @InjectModel('Wallet') private readonly wallets: Model<Wallet>,
    @InjectModel('Payment') private readonly payments: Model<Payment>,
    @InjectModel('Withdrawal') private readonly withdrawals: Model<Withdrawal>,
    @InjectModel('Organization') private readonly orgs: Model<Organization>,
    private readonly wallet: WalletService,
    private readonly subscriptions: SubscriptionsService,
    private readonly entitlements: EntitlementsService,
    private readonly credits: CreditsService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private agg<R>(model: Model<never>, pipeline: PipelineStage[]): Promise<R[]> {
    return model
      .aggregate<R>(pipeline)
      .option({ [CROSS_TENANT]: true })
      .exec();
  }

  async overview(from: Date, to: Date) {
    const [subsByStatus, mrr, walletTotals, payments, ai, pendingManual, pendingWithdrawals] =
      await Promise.all([
        this.agg<{ _id: { status: string; plan: string }; count: number }>(this.subs as never, [
          { $group: { _id: { status: '$status', plan: '$planCode' }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        this.agg<{ _id: string; mrrMinor: number; payingBusinesses: number }>(this.subs as never, [
          {
            $match: {
              status: { $in: ['active', 'past_due'] },
              source: { $in: ['wallet', 'gateway'] },
              interval: { $in: ['month', 'year'] },
            },
          },
          {
            $group: {
              _id: '$currency',
              mrrMinor: {
                $sum: {
                  $cond: [
                    { $eq: ['$interval', 'year'] },
                    { $divide: ['$priceMinor', 12] },
                    '$priceMinor',
                  ],
                },
              },
              payingBusinesses: { $sum: 1 },
            },
          },
        ]),
        this.agg<{
          _id: string;
          balanceMinor: number;
          heldMinor: number;
          bonusMinor: number;
          wallets: number;
        }>(this.wallets as never, [
          {
            $group: {
              _id: '$currency',
              balanceMinor: { $sum: '$balanceMinor' },
              heldMinor: { $sum: '$heldMinor' },
              bonusMinor: { $sum: '$bonusMinor' },
              wallets: { $sum: 1 },
            },
          },
        ]),
        this.agg<{
          _id: { currency: string; gateway: string };
          amountMinor: number;
          count: number;
        }>(this.payments as never, [
          { $match: { status: 'succeeded', succeededAt: { $gte: from, $lt: to } } },
          {
            $group: {
              _id: { currency: '$currency', gateway: '$gateway' },
              amountMinor: { $sum: '$amountMinor' },
              count: { $sum: 1 },
            },
          },
        ]),
        this.profit(from, to, 'tier'),
        this.payments
          .countDocuments({ status: 'pending', gateway: 'manual' }, { [CROSS_TENANT]: true })
          .exec(),
        this.withdrawals
          .countDocuments({ status: { $in: ['requested', 'approved'] } }, { [CROSS_TENANT]: true })
          .exec(),
      ]);
    const aiTotals = new Map<
      string,
      {
        requests: number;
        credits: number;
        collectedMinor: number;
        billedMinor: number;
        costMinor: number;
      }
    >();
    for (const row of ai.rows) {
      const t = aiTotals.get(row.currency) ?? {
        requests: 0,
        credits: 0,
        collectedMinor: 0,
        billedMinor: 0,
        costMinor: 0,
      };
      t.requests += row.requests;
      t.credits += row.credits;
      t.collectedMinor += row.collectedMinor;
      t.billedMinor += row.billedMinor;
      t.costMinor += row.costMinor;
      aiTotals.set(row.currency, t);
    }
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      subscriptions: subsByStatus.map((r) => ({
        status: r._id.status,
        planCode: r._id.plan,
        count: r.count,
      })),
      mrr: mrr.map((r) => ({
        currency: r._id,
        mrrMinor: Math.round(r.mrrMinor),
        payingBusinesses: r.payingBusinesses,
      })),
      wallets: walletTotals.map((r) => ({
        currency: r._id,
        balanceMinor: r.balanceMinor,
        heldMinor: r.heldMinor,
        bonusMinor: r.bonusMinor,
        cashMinor: r.balanceMinor - r.bonusMinor,
        wallets: r.wallets,
      })),
      payments: payments.map((r) => ({
        currency: r._id.currency,
        gateway: r._id.gateway,
        amountMinor: r.amountMinor,
        count: r.count,
      })),
      ai: [...aiTotals.entries()].map(([currency, t]) =>
        withMargin({ currency, ...t, credits: Math.round(t.credits * 100) / 100 }),
      ),
      queues: { pendingManualPayments: pendingManual, openWithdrawals: pendingWithdrawals },
    };
  }

  private get timezone(): string {
    return this.config.get('PLATFORM_REPORT_TIMEZONE');
  }

  /** AI revenue vs real provider cost for a period, grouped as asked. */
  async profit(from: Date, to: Date, groupBy: ProfitGroupBy, orgId?: string) {
    const key: Record<ProfitGroupBy, unknown> = {
      day: { $dateToString: { format: '%Y-%m-%d', date: '$settledAt', timezone: this.timezone } },
      org: { $toString: '$orgId' },
      model: {
        $concat: [{ $ifNull: ['$provider', 'unknown'] }, '/', { $ifNull: ['$model', 'unknown'] }],
      },
      feature: '$feature',
      tier: '$tier',
    };
    const rows = await this.agg<
      { _id: { key: string; currency: string } } & Omit<ProfitRow, 'key' | 'currency'>
    >(this.usage as never, [
      {
        $match: {
          status: 'settled',
          settledAt: { $gte: from, $lt: to },
          ...(orgId ? { orgId: new Types.ObjectId(orgId) } : {}),
        },
      },
      {
        $group: {
          _id: { key: key[groupBy], currency: '$currency' },
          requests: { $sum: 1 },
          credits: { $sum: '$credits' },
          billedMinor: { $sum: '$billedMinor' },
          collectedMinor: { $sum: { $subtract: ['$billedMinor', '$shortfallMinor'] } },
          costMinor: { $sum: '$costMinor' },
          costUsdMicros: { $sum: '$costUsdMicros' },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          cachedInputTokens: { $sum: '$cachedInputTokens' },
          cacheWriteInputTokens: { $sum: { $ifNull: ['$cacheWriteInputTokens', 0] } },
        },
      },
      { $sort: { '_id.key': 1 } },
    ]);
    let names = new Map<string, string>();
    if (groupBy === 'org' && rows.length) {
      const orgs = await this.orgs
        .find({ _id: { $in: rows.map((r) => new Types.ObjectId(r._id.key)) } }, { name: 1 })
        .lean()
        .exec();
      names = new Map(orgs.map((o) => [o._id.toHexString(), o.name]));
    }
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy,
      timezone: this.timezone,
      rows: rows.map((r) => {
        const { _id, ...rest } = r;
        return withMargin({
          key: _id.key,
          ...(groupBy === 'org' ? { label: names.get(_id.key) ?? null } : {}),
          currency: _id.currency,
          ...rest,
          credits: Math.round(rest.credits * 100) / 100,
        });
      }),
    };
  }

  // ---------------------------------------------------------------- one business

  private async ensureOrg(orgId: string) {
    if (!Types.ObjectId.isValid(orgId)) throw AppError.notFound('organization');
    const org = await this.orgs.findById(orgId, { name: 1, currency: 1 }).lean().exec();
    if (!org) throw AppError.notFound('organization');
    return org;
  }

  inTenant<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    const actor = RequestContext.actor();
    return RequestContext.withTenant(orgId, fn, actor);
  }

  async tenantBilling(orgId: string) {
    const org = await this.ensureOrg(orgId);
    return this.inTenant(orgId, async () => {
      const [sub, wallet, ledger, recentUsage, reconcile] = await Promise.all([
        this.subscriptions.get(),
        this.wallet.get(),
        this.wallet.history({ limit: 20 }),
        this.usage
          .find({ orgId: new Types.ObjectId(orgId) })
          .sort({ _id: -1 })
          .limit(20)
          .lean<AiUsageDoc[]>()
          .exec(),
        this.wallet.reconcile(),
      ]);
      const now = new Date();
      const monthAgo = new Date(now.getTime() - 30 * 24 * 3600_000);
      return {
        org: { id: orgId, name: org.name, currency: org.currency },
        subscription: {
          ...toSubscriptionDto(sub, await this.entitlements.forOrg(orgId)),
          overrides: sub.overrides,
          source: sub.source,
        },
        wallet: {
          ...toBalance(wallet),
          lowBalanceThresholdMinor: wallet.lowBalanceThresholdMinor,
          reconciled: reconcile.ok,
          ledgerSumMinor: reconcile.ledgerSumMinor,
        },
        ledger: ledger.items.map((e) => ({
          id: e._id.toHexString(),
          type: e.type,
          amountMinor: e.amountMinor,
          balanceAfterMinor: e.balanceAfterMinor,
          description: e.description,
          credits: e.credits ?? null,
          actor: e.actor,
          at: e.createdAt.toISOString(),
        })),
        aiLast30Days: (await this.profit(monthAgo, now, 'tier', orgId)).rows,
        recentUsage: recentUsage.map(toPlatformUsageDto),
      };
    });
  }

  /** Manual wallet change by the platform: bank-transfer top-ups, goodwill credit, corrections. */
  async adjustWallet(
    orgId: string,
    input: {
      direction: 'credit' | 'debit';
      type: Extract<LedgerType, 'topup' | 'bonus' | 'adjustment' | 'refund'>;
      amountMinor: number;
      note: string;
      idempotencyKey: string;
    },
    actorId: string,
  ) {
    await this.ensureOrg(orgId);
    if (input.direction === 'debit' && input.type !== 'adjustment')
      throw AppError.validation([{ path: 'type', message: 'Debits must use type "adjustment"' }]);
    return this.inTenant(orgId, async () => {
      const movement = {
        type: input.type,
        amountMinor: input.amountMinor,
        idempotencyKey: `platform:${input.idempotencyKey}`,
        description: input.note,
        actor: { type: 'platform', id: actorId },
        metadata: { note: input.note },
      };
      const { entry, applied } =
        input.direction === 'credit'
          ? await this.wallet.credit(movement)
          : await this.wallet.debit({ ...movement, allowFrozen: true });
      if (applied) {
        await this.audit.record({
          action: `platform.wallet.${input.direction}`,
          orgId,
          target: { type: 'wallet', id: orgId },
          metadata: {
            type: input.type,
            amountMinor: input.amountMinor,
            note: input.note,
            ledgerEntryId: entry._id.toHexString(),
          },
        });
      }
      return { applied, balance: await this.wallet.balance() };
    });
  }

  async setWalletStatus(orgId: string, status: 'active' | 'frozen', note: string) {
    await this.ensureOrg(orgId);
    return this.inTenant(orgId, async () => {
      await this.wallet.setStatus(status);
      await this.audit.record({
        action: `platform.wallet.${status === 'frozen' ? 'frozen' : 'unfrozen'}`,
        orgId,
        target: { type: 'wallet', id: orgId },
        metadata: { note },
      });
      return this.wallet.balance();
    });
  }

  async usageForPlatform(q: { orgId?: string; limit: number; before?: string }) {
    const filter: Record<string, unknown> = {};
    if (q.orgId) filter.orgId = new Types.ObjectId(q.orgId);
    if (q.before && Types.ObjectId.isValid(q.before))
      filter._id = { $lt: new Types.ObjectId(q.before) };
    const docs = await this.usage
      .find(filter, null, { [CROSS_TENANT]: true })
      .sort({ _id: -1 })
      .limit(q.limit + 1)
      .lean<AiUsageDoc[]>()
      .exec();
    const items = docs.slice(0, q.limit);
    return {
      items: items.map(toPlatformUsageDto),
      nextCursor: docs.length > q.limit ? items[items.length - 1]!._id.toHexString() : null,
    };
  }
}
