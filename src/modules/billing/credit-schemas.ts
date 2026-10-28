import { Schema, type Types } from 'mongoose';
import { platformSchema, tenantSchema } from '../../infra/database/schema-helpers.js';

export const MODEL_TIERS = ['fast', 'standard', 'advanced'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface TierRate {
  tier: ModelTier;
  /** Credits charged per 1,000 input tokens (fractional allowed, e.g. 2.5). */
  inputCreditsPer1k: number;
  outputCreditsPer1k: number;
}

/**
 * The price list for AI usage, versioned so every usage record points at the exact rate
 * it was billed with. Set by the super-admin; clients see credits and taka only.
 */
export interface CreditRate {
  version: number;
  currency: string;
  /** Price of one credit in minor units of `currency` (e.g. 10 = ৳0.10). */
  creditPriceMinor: number;
  tiers: TierRate[];
  minimumCreditsPerRequest: number;
  /** Platform-only: local currency per USD, scaled by 10,000 (122.5 = 1,225,000). */
  usdRateScaled: number;
  effectiveFrom: Date;
  createdBy: string;
  note?: string;
}

export const creditRateSchema = platformSchema<CreditRate>(
  {
    version: { type: Number, required: true },
    currency: { type: String, required: true },
    creditPriceMinor: { type: Number, required: true, min: 1 },
    tiers: {
      type: [
        new Schema(
          {
            tier: { type: String, enum: MODEL_TIERS, required: true },
            inputCreditsPer1k: { type: Number, required: true, min: 0 },
            outputCreditsPer1k: { type: Number, required: true, min: 0 },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      required: true,
    },
    minimumCreditsPerRequest: { type: Number, default: 1, min: 0 },
    usdRateScaled: { type: Number, required: true, min: 1 },
    effectiveFrom: { type: Date, required: true },
    createdBy: { type: String, required: true },
    note: String,
  },
  { collection: 'credit_rates' },
);
creditRateSchema.index({ currency: 1, version: -1 }, { unique: true });

/**
 * AI models the platform may route to, with their real provider prices. Model names live
 * here (data), never in business logic. Prices are in micro-USD per million tokens.
 */
export interface AiModel {
  provider: 'anthropic' | 'openai' | 'google' | 'other';
  model: string;
  label: string;
  tier: ModelTier;
  inputUsdMicrosPerMTok: number;
  outputUsdMicrosPerMTok: number;
  cachedInputUsdMicrosPerMTok: number;
  /** Price of writing prompt tokens to the provider's cache; when unset, 1.25 × the input price. */
  cacheWriteUsdMicrosPerMTok?: number;
  /** Higher prices some models charge once a prompt passes a size threshold. */
  longContext?: {
    thresholdTokens: number;
    inputUsdMicrosPerMTok: number;
    outputUsdMicrosPerMTok: number;
  };
  contextWindow: number;
  enabled: boolean;
  isDefaultForTier: boolean;
}

export const aiModelSchema = platformSchema<AiModel>(
  {
    provider: { type: String, enum: ['anthropic', 'openai', 'google', 'other'], required: true },
    model: { type: String, required: true },
    label: { type: String, required: true },
    tier: { type: String, enum: MODEL_TIERS, required: true },
    inputUsdMicrosPerMTok: { type: Number, required: true, min: 0 },
    outputUsdMicrosPerMTok: { type: Number, required: true, min: 0 },
    cachedInputUsdMicrosPerMTok: { type: Number, default: 0, min: 0 },
    cacheWriteUsdMicrosPerMTok: { type: Number, min: 0 },
    longContext: {
      type: new Schema(
        {
          thresholdTokens: { type: Number, required: true, min: 1 },
          inputUsdMicrosPerMTok: { type: Number, required: true, min: 0 },
          outputUsdMicrosPerMTok: { type: Number, required: true, min: 0 },
        },
        { _id: false, strict: 'throw' },
      ),
      default: undefined,
    },
    contextWindow: { type: Number, default: 200_000 },
    enabled: { type: Boolean, default: true },
    isDefaultForTier: { type: Boolean, default: false },
  },
  { collection: 'ai_models' },
);
aiModelSchema.index({ provider: 1, model: 1 }, { unique: true });

export type UsageStatus = 'reserved' | 'settled' | 'released';

/** One metered AI call. Cost fields are platform-only and never sent to merchants. */
export interface AiUsage {
  orgId: Types.ObjectId;
  requestId: string;
  feature: string;
  tier: ModelTier;
  status: UsageStatus;
  currency: string;
  reservedMinor: number;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  credits: number;
  billedMinor: number;
  costUsdMicros: number;
  costMinor: number;
  /** Part of the bill the wallet could not cover at settlement (usage already happened). */
  shortfallMinor: number;
  creditRateVersion: number;
  reference?: { type: string; id: string };
  settledAt?: Date;
}

export const aiUsageSchema = tenantSchema<AiUsage>(
  {
    requestId: { type: String, required: true },
    feature: { type: String, required: true },
    tier: { type: String, enum: MODEL_TIERS, required: true },
    status: { type: String, enum: ['reserved', 'settled', 'released'], required: true },
    currency: { type: String, required: true },
    reservedMinor: { type: Number, required: true, min: 0 },
    provider: String,
    model: String,
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cachedInputTokens: { type: Number, default: 0 },
    cacheWriteInputTokens: { type: Number, default: 0 },
    credits: { type: Number, default: 0 },
    billedMinor: { type: Number, default: 0 },
    costUsdMicros: { type: Number, default: 0 },
    costMinor: { type: Number, default: 0 },
    shortfallMinor: { type: Number, default: 0 },
    creditRateVersion: { type: Number, required: true },
    reference: { type: new Schema({ type: String, id: String }, { _id: false, strict: 'throw' }) },
    settledAt: Date,
  },
  { collection: 'ai_usage' },
);
aiUsageSchema.index({ orgId: 1, requestId: 1 }, { unique: true });
aiUsageSchema.index({ orgId: 1, createdAt: -1 });
aiUsageSchema.index({ status: 1, createdAt: 1 });
aiUsageSchema.index({ settledAt: 1 });
