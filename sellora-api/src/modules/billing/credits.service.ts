import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DEFAULT_AI_MODELS, DEFAULT_CREDIT_RATE } from './billing-defaults.js';
import {
  creditsFor,
  maxChargeFor,
  promptTokens,
  providerCostUsdMicros,
  usdMicrosToMinor,
  type TokenUsage,
} from './credit-math.js';
import type { AiModel, AiUsage, CreditRate, ModelTier, TierRate } from './credit-schemas.js';
import { WalletService, toBalance } from './wallet.service.js';

export type CreditRateDoc = WithId<CreditRate>;
export type AiModelDoc = WithId<AiModel>;
export type AiUsageDoc = WithId<AiUsage>;

export const WALLET_LOW_BALANCE = 'billing.wallet_low_balance';

@Injectable()
export class AiUsageRepository extends TenantScopedRepository<AiUsage> {
  constructor(@InjectModel('AiUsage') model: Model<AiUsage>) {
    super(model);
  }
}

export interface ReserveInput {
  requestId: string;
  feature: string;
  tier: ModelTier;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  reference?: { type: string; id: string };
}

export interface SettleInput extends TokenUsage {
  requestId: string;
  provider: string;
  model: string;
}

export interface PublishRateInput {
  currency: string;
  creditPriceMinor: number;
  tiers: TierRate[];
  minimumCreditsPerRequest: number;
  usdRateScaled: number;
  effectiveFrom?: Date;
  note?: string;
}

const RATE_CACHE_MS = 10_000;

/** The credit view a merchant may see: no provider, model or cost fields. */
export function toMerchantUsageDto(u: AiUsageDoc) {
  return {
    id: u._id.toHexString(),
    requestId: u.requestId,
    feature: u.feature,
    tier: u.tier,
    status: u.status,
    tokens: {
      input: promptTokens({
        inputTokens: u.inputTokens,
        cachedInputTokens: u.cachedInputTokens,
        cacheWriteInputTokens: u.cacheWriteInputTokens ?? 0,
        outputTokens: 0,
      }),
      output: u.outputTokens,
    },
    credits: u.credits,
    chargedMinor: u.billedMinor - u.shortfallMinor,
    reference: u.reference ?? null,
    at: u.createdAt.toISOString(),
  };
}

export function toPublicRateDto(rate: CreditRateDoc) {
  return {
    version: rate.version,
    currency: rate.currency,
    creditPriceMinor: rate.creditPriceMinor,
    minimumCreditsPerRequest: rate.minimumCreditsPerRequest,
    tiers: rate.tiers.map((t) => ({
      tier: t.tier,
      inputCreditsPer1k: t.inputCreditsPer1k,
      outputCreditsPer1k: t.outputCreditsPer1k,
    })),
    effectiveFrom: rate.effectiveFrom.toISOString(),
  };
}

export function toPlatformRateDto(rate: CreditRateDoc) {
  return {
    ...toPublicRateDto(rate),
    id: rate._id.toHexString(),
    usdRateScaled: rate.usdRateScaled,
    usdRate: rate.usdRateScaled / 10_000,
    note: rate.note ?? null,
    createdBy: rate.createdBy,
    createdAt: rate.createdAt.toISOString(),
  };
}

export function toAiModelDto(m: AiModelDoc) {
  return {
    id: m._id.toHexString(),
    provider: m.provider,
    model: m.model,
    label: m.label,
    tier: m.tier,
    inputUsdPerMTok: m.inputUsdMicrosPerMTok / 1_000_000,
    outputUsdPerMTok: m.outputUsdMicrosPerMTok / 1_000_000,
    cachedInputUsdPerMTok: m.cachedInputUsdMicrosPerMTok / 1_000_000,
    cacheWriteUsdPerMTok:
      m.cacheWriteUsdMicrosPerMTok === undefined ? null : m.cacheWriteUsdMicrosPerMTok / 1_000_000,
    longContext: m.longContext
      ? {
          thresholdTokens: m.longContext.thresholdTokens,
          inputUsdPerMTok: m.longContext.inputUsdMicrosPerMTok / 1_000_000,
          outputUsdPerMTok: m.longContext.outputUsdMicrosPerMTok / 1_000_000,
        }
      : null,
    contextWindow: m.contextWindow,
    imageInput: m.imageInput === true,
    enabled: m.enabled,
    isDefaultForTier: m.isDefaultForTier,
  };
}

/**
 * AI credits: the versioned price list, the model catalogue with real provider prices,
 * and metering. An AI call is metered in three steps so a merchant can never spend money
 * they do not have and a crash can never double-charge:
 *
 *  1. reserve(): hold the worst-case charge in the wallet before calling the provider;
 *  2. settle(): after the call, charge the real token count and release the hold;
 *  3. release(): if the call failed, release the hold without charging.
 *
 * Every step is idempotent by requestId.
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);
  private readonly rateCache = new Map<string, { at: number; rate: CreditRateDoc }>();

  constructor(
    @InjectModel('CreditRate') private readonly rates: Model<CreditRate>,
    @InjectModel('AiModel') private readonly models: Model<AiModel>,
    @InjectModel('AiUsage') private readonly usageModel: Model<AiUsage>,
    private readonly usage: AiUsageRepository,
    private readonly wallet: WalletService,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------- price list

  async seedDefaults(): Promise<void> {
    await this.rates
      .updateOne(
        { currency: DEFAULT_CREDIT_RATE.currency, version: DEFAULT_CREDIT_RATE.version },
        {
          $setOnInsert: {
            ...DEFAULT_CREDIT_RATE,
            effectiveFrom: new Date(0),
            createdBy: 'system:seed',
          },
        },
        { upsert: true },
      )
      .exec()
      .catch((err: unknown) => {
        if (!isDuplicateKey(err)) throw err;
      });
    for (const m of DEFAULT_AI_MODELS) {
      await this.models
        .updateOne({ provider: m.provider, model: m.model }, { $setOnInsert: m }, { upsert: true })
        .exec()
        .catch((err: unknown) => {
          if (!isDuplicateKey(err)) throw err;
        });
      // Catalogues seeded before photo support learn it once; an admin's choice is kept.
      await this.models
        .updateOne(
          { provider: m.provider, model: m.model, imageInput: { $exists: false } },
          { $set: { imageInput: m.imageInput } },
        )
        .exec();
    }
  }

  /** The newest rate in force for `currency`. A currency without a rate is an error, never a guess. */
  async currentRate(currency: string): Promise<CreditRateDoc> {
    const cached = this.rateCache.get(currency);
    if (cached && Date.now() - cached.at < RATE_CACHE_MS) return cached.rate;
    const rate = await this.rates
      .findOne({ currency, effectiveFrom: { $lte: new Date() } })
      .sort({ version: -1 })
      .lean<CreditRateDoc>()
      .exec();
    if (!rate)
      throw AppError.unprocessable(
        'credit_rate_missing',
        `AI credits are not priced in ${currency} yet. Contact support.`,
      );
    this.rateCache.set(currency, { at: Date.now(), rate });
    return rate;
  }

  async rateHistory(currency?: string): Promise<CreditRateDoc[]> {
    return this.rates
      .find(currency ? { currency } : {})
      .sort({ currency: 1, version: -1 })
      .limit(200)
      .lean<CreditRateDoc[]>()
      .exec();
  }

  /** Publishes a new version. Old usage keeps pointing at the version it was billed with. */
  async publishRate(input: PublishRateInput, actorId: string): Promise<CreditRateDoc> {
    const tiers = new Set(input.tiers.map((t) => t.tier));
    if (tiers.size !== input.tiers.length)
      throw AppError.validation([{ path: 'tiers', message: 'Each tier may appear once' }]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await this.rates
        .findOne({ currency: input.currency })
        .sort({ version: -1 })
        .lean<CreditRateDoc>()
        .exec();
      const version = (latest?.version ?? 0) + 1;
      try {
        const [created] = await this.rates.create([
          {
            ...input,
            version,
            effectiveFrom: input.effectiveFrom ?? new Date(),
            createdBy: actorId,
          },
        ]);
        this.rateCache.delete(input.currency);
        const doc = created!.toObject() as unknown as CreditRateDoc;
        await this.audit.record({
          action: 'platform.credit_rate.published',
          target: {
            type: 'credit_rate',
            id: doc._id.toHexString(),
            label: `${input.currency} v${version}`,
          },
          metadata: {
            previous: latest ? toPlatformRateDto(latest) : null,
            next: toPlatformRateDto(doc),
          },
        });
        return doc;
      } catch (err) {
        if (isDuplicateKey(err)) continue;
        throw err;
      }
    }
    throw AppError.conflict(
      'rate_conflict',
      'Another rate was published at the same time. Try again.',
    );
  }

  // ---------------------------------------------------------------- models

  async listModels(): Promise<AiModelDoc[]> {
    return this.models
      .find({})
      .sort({ tier: 1, provider: 1, model: 1 })
      .lean<AiModelDoc[]>()
      .exec();
  }

  async createModel(input: AiModel): Promise<AiModelDoc> {
    try {
      const doc = await this.tx.run(async () => {
        if (input.isDefaultForTier)
          await this.models
            .updateMany({ tier: input.tier }, { $set: { isDefaultForTier: false } })
            .exec();
        const [created] = await this.models.create([input]);
        return created!.toObject() as unknown as AiModelDoc;
      });
      await this.audit.record({
        action: 'platform.ai_model.created',
        target: { type: 'ai_model', id: doc._id.toHexString(), label: doc.model },
        metadata: { model: toAiModelDto(doc) },
      });
      return doc;
    } catch (err) {
      if (isDuplicateKey(err))
        throw AppError.conflict('model_exists', 'This model is already in the catalogue.');
      throw err;
    }
  }

  async updateModel(id: string, patch: Partial<AiModel>): Promise<AiModelDoc> {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('ai_model');
    const before = await this.models.findById(id).lean<AiModelDoc>().exec();
    if (!before) throw AppError.notFound('ai_model');
    const tier = patch.tier ?? before.tier;
    const after = await this.tx.run(async () => {
      if (patch.isDefaultForTier)
        await this.models
          .updateMany({ tier, _id: { $ne: before._id } }, { $set: { isDefaultForTier: false } })
          .exec();
      return this.models
        .findByIdAndUpdate(id, { $set: patch }, { returnDocument: 'after', runValidators: true })
        .lean<AiModelDoc>()
        .exec();
    });
    await this.audit.record({
      action: 'platform.ai_model.updated',
      target: { type: 'ai_model', id, label: before.model },
      metadata: { before: toAiModelDto(before), after: toAiModelDto(after!) },
    });
    return after!;
  }

  /** The model to call for a tier: the enabled default, else any enabled model of that tier. */
  async modelForTier(tier: ModelTier): Promise<AiModelDoc> {
    const model =
      (await this.models
        .findOne({ tier, enabled: true, isDefaultForTier: true })
        .lean<AiModelDoc>()
        .exec()) ??
      (await this.models
        .findOne({ tier, enabled: true })
        .sort({ updatedAt: -1 })
        .lean<AiModelDoc>()
        .exec());
    if (!model)
      throw AppError.unprocessable(
        'ai_model_unavailable',
        `No AI model is enabled for the ${tier} tier.`,
      );
    return model;
  }

  private async modelByName(provider: string, model: string): Promise<AiModelDoc | null> {
    return this.models
      .findOne({ provider: provider as AiModel['provider'], model })
      .lean<AiModelDoc>()
      .exec();
  }

  // ---------------------------------------------------------------- metering

  /** Estimated credits for a call, so screens can show "about N credits". */
  async quote(tier: ModelTier, usage: TokenUsage) {
    const currency = (await this.wallet.get()).currency;
    const rate = await this.currentRate(currency);
    const charge = creditsFor(rate, tier, usage);
    return {
      tier,
      credits: charge.credits,
      amountMinor: charge.billedMinor,
      currency,
      rateVersion: rate.version,
    };
  }

  async reserve(input: ReserveInput): Promise<AiUsageDoc> {
    const existing = await this.usage.findOne({ requestId: input.requestId });
    if (existing) return existing;
    const wallet = await this.wallet.get();
    const rate = await this.currentRate(wallet.currency);
    const max = maxChargeFor(rate, input.tier, input.estimatedInputTokens, input.maxOutputTokens);
    try {
      return await this.tx.run(async () => {
        await this.wallet.hold(max.billedMinor);
        return this.usage.create({
          requestId: input.requestId,
          feature: input.feature,
          tier: input.tier,
          status: 'reserved',
          currency: wallet.currency,
          reservedMinor: max.billedMinor,
          creditRateVersion: rate.version,
          ...(input.reference ? { reference: input.reference } : {}),
        });
      });
    } catch (err) {
      if (isDuplicateKey(err)) return (await this.usage.findOne({ requestId: input.requestId }))!;
      throw err;
    }
  }

  /**
   * Charges the real usage. The provider call already happened, so a wallet that cannot
   * cover a bill above the reservation is charged what it has and the rest is recorded as
   * a shortfall for the platform to see; it never fails the settlement.
   */
  async settle(input: SettleInput): Promise<AiUsageDoc> {
    const result = await this.tx.run(async () => {
      const usage = await this.usage.findOne({ requestId: input.requestId });
      if (!usage) throw AppError.notFound('ai_usage');
      if (usage.status !== 'reserved') return usage;
      const wallet = await this.wallet.get();
      const rate =
        (await this.rates
          .findOne({ currency: wallet.currency, version: usage.creditRateVersion })
          .lean<CreditRateDoc>()
          .exec()) ?? (await this.currentRate(wallet.currency));
      const tokens: TokenUsage = {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        cacheWriteInputTokens: input.cacheWriteInputTokens ?? 0,
      };
      const charge = creditsFor(rate, usage.tier, tokens);
      const model = await this.modelByName(input.provider, input.model);
      if (!model)
        this.logger.warn(
          { provider: input.provider, model: input.model },
          'Settling usage for a model missing from the catalogue; cost recorded as 0',
        );
      const costUsdMicros = model ? providerCostUsdMicros(model, tokens) : 0;
      const costMinor = usdMicrosToMinor(costUsdMicros, rate);

      // Spendable for this charge = everything not held by other reservations.
      const spendable = wallet.balanceMinor - (wallet.heldMinor - usage.reservedMinor);
      const chargeMinor = Math.max(0, Math.min(charge.billedMinor, spendable));
      if (chargeMinor > 0) {
        await this.wallet.debit({
          type: 'ai_usage',
          amountMinor: chargeMinor,
          consumeHeldMinor: usage.reservedMinor,
          allowFrozen: true,
          idempotencyKey: `ai:${input.requestId}`,
          description: `AI ${usage.feature.replace(/_/g, ' ')} (${charge.credits} credits)`,
          credits: charge.credits,
          reference: { type: 'ai_usage', id: usage._id.toHexString() },
          actor: { type: 'system', id: 'ai-metering' },
        });
      } else {
        await this.wallet.release(usage.reservedMinor);
      }
      return this.usage.findOneAndUpdate(
        { _id: usage._id, status: 'reserved' },
        {
          $set: {
            status: 'settled',
            provider: input.provider,
            model: input.model,
            inputTokens: tokens.inputTokens,
            outputTokens: tokens.outputTokens,
            cachedInputTokens: tokens.cachedInputTokens ?? 0,
            cacheWriteInputTokens: tokens.cacheWriteInputTokens ?? 0,
            credits: charge.credits,
            billedMinor: charge.billedMinor,
            shortfallMinor: charge.billedMinor - chargeMinor,
            costUsdMicros,
            costMinor,
            creditRateVersion: rate.version,
            settledAt: new Date(),
          },
        },
      );
    });
    if (!result)
      throw AppError.conflict('usage_changed', 'This AI request changed while settling. Retry.');
    await this.notifyIfLow();
    return result;
  }

  async release(requestId: string): Promise<AiUsageDoc | null> {
    return this.tx.run(async () => {
      const usage = await this.usage.findOne({ requestId });
      if (!usage || usage.status !== 'reserved') return usage;
      await this.wallet.release(usage.reservedMinor);
      return this.usage.findOneAndUpdate(
        { _id: usage._id, status: 'reserved' },
        { $set: { status: 'released', settledAt: new Date() } },
      );
    });
  }

  /** Reservations left open by crashed calls, across all businesses (worker). */
  async findStaleReservations(
    olderThan: Date,
    limit = 500,
  ): Promise<{ orgId: string; requestId: string }[]> {
    const docs = await this.usageModel
      .find(
        { status: 'reserved', createdAt: { $lt: olderThan } },
        { orgId: 1, requestId: 1 },
        { [CROSS_TENANT]: true },
      )
      .limit(limit)
      .lean()
      .exec();
    return docs.map((d) => ({ orgId: d.orgId.toHexString(), requestId: d.requestId }));
  }

  private async notifyIfLow(): Promise<void> {
    const wallet = await this.wallet.get();
    const balance = toBalance(wallet);
    if (balance.availableMinor >= wallet.lowBalanceThresholdMinor) return;
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    if (wallet.lowBalanceNotifiedAt && wallet.lowBalanceNotifiedAt > dayAgo) return;
    this.events.emit(WALLET_LOW_BALANCE, {
      orgId: RequestContext.tenant()!.orgId,
      availableMinor: balance.availableMinor,
      currency: wallet.currency,
    });
    await this.wallet.markLowBalanceNotified();
  }

  // ---------------------------------------------------------------- merchant reporting

  async listUsage(q: { limit: number; cursor?: string; feature?: string }) {
    return this.usage.paginate(
      { status: { $in: ['settled', 'reserved'] }, ...(q.feature ? { feature: q.feature } : {}) },
      q,
    );
  }

  /** Daily credits and spend for the merchant's own dashboard. */
  async usageSummary(from: Date, to: Date, timezone: string) {
    const [byDay, byFeature] = await Promise.all([
      this.usage.aggregate<{
        _id: string;
        credits: number;
        chargedMinor: number;
        requests: number;
      }>([
        { $match: { status: 'settled', settledAt: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$settledAt', timezone } },
            credits: { $sum: '$credits' },
            chargedMinor: { $sum: { $subtract: ['$billedMinor', '$shortfallMinor'] } },
            requests: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      this.usage.aggregate<{
        _id: string;
        credits: number;
        chargedMinor: number;
        requests: number;
      }>([
        { $match: { status: 'settled', settledAt: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: '$feature',
            credits: { $sum: '$credits' },
            chargedMinor: { $sum: { $subtract: ['$billedMinor', '$shortfallMinor'] } },
            requests: { $sum: 1 },
          },
        },
        { $sort: { credits: -1 } },
      ]),
    ]);
    const round = (n: number) => Math.round(n * 100) / 100;
    const totals = byDay.reduce(
      (acc, d) => ({
        credits: acc.credits + d.credits,
        chargedMinor: acc.chargedMinor + d.chargedMinor,
        requests: acc.requests + d.requests,
      }),
      { credits: 0, chargedMinor: 0, requests: 0 },
    );
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: { ...totals, credits: round(totals.credits) },
      byDay: byDay.map((d) => ({
        date: d._id,
        credits: round(d.credits),
        chargedMinor: d.chargedMinor,
        requests: d.requests,
      })),
      byFeature: byFeature.map((d) => ({
        feature: d._id,
        credits: round(d.credits),
        chargedMinor: d.chargedMinor,
        requests: d.requests,
      })),
    };
  }
}
