import { z } from 'zod';
import {
  currencySchema,
  moneyMinorSchema,
  objectIdSchema,
  paginationQuerySchema,
} from '../../common/validation/schemas.js';
import { BILLING_INTERVALS, FEATURE_MODULE_KEYS, LIMIT_KEYS } from './feature-modules.js';
import { MODEL_PURPOSES, MODEL_TIERS } from './credit-schemas.js';
import { GATEWAYS, type GatewayKey } from './payment-schemas.js';
import { LEDGER_TYPES } from './schemas.js';

const positiveMinor = moneyMinorSchema.refine((v) => v > 0, 'Must be greater than zero');
const idempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'Use letters, digits and _ . : - only');
const planCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use lowercase letters, digits and dashes');
const interval = z.enum(BILLING_INTERVALS);
const onlineGateway = z.enum(
  GATEWAYS.filter((g): g is Exclude<GatewayKey, 'manual'> => g !== 'manual') as [
    Exclude<GatewayKey, 'manual'>,
    ...Exclude<GatewayKey, 'manual'>[],
  ],
);
const isoDate = z.coerce.date();

// ---------------------------------------------------------------- merchant

export const subscribeBody = z.object({ planCode, interval }).strict();

export const planCheckoutBody = z
  .object({ planCode, interval, gateway: onlineGateway, idempotencyKey: idempotencyKey.optional() })
  .strict();

export const topupBody = z
  .object({
    amountMinor: positiveMinor,
    gateway: onlineGateway,
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

export const manualTopupBody = z
  .object({
    amountMinor: positiveMinor,
    method: z.enum(['bkash', 'nagad', 'rocket', 'bank', 'cash']),
    senderAccount: z.string().trim().min(3).max(120),
    transactionRef: z.string().trim().min(4).max(80),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const withdrawalBody = z
  .object({
    amountMinor: positiveMinor,
    method: z.enum(['bkash', 'nagad', 'bank', 'original_method']),
    destination: z.string().trim().min(3).max(200),
  })
  .strict();

export const ledgerQuery = paginationQuerySchema.extend({ type: z.enum(LEDGER_TYPES).optional() });

export const usageQuery = paginationQuerySchema.extend({ feature: z.string().max(60).optional() });

export const rangeQuery = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((q) => !q.from || !q.to || q.from < q.to, {
    message: '"from" must be before "to"',
    path: ['from'],
  });

export const quoteBody = z
  .object({
    tier: z.enum(MODEL_TIERS),
    inputTokens: z.number().int().min(0).max(2_000_000),
    outputTokens: z.number().int().min(0).max(200_000),
  })
  .strict();

// ---------------------------------------------------------------- platform

const limitsShape = Object.fromEntries(
  LIMIT_KEYS.map((k) => [k, z.number().int().min(0).nullable()]),
) as Record<(typeof LIMIT_KEYS)[number], z.ZodNullable<z.ZodNumber>>;
const limitsSchema = z.object(limitsShape).strict();

const priceSchema = z
  .object({ interval, currency: currencySchema, amountMinor: moneyMinorSchema })
  .strict();

/** Plan fields without defaults, so a partial update never resets what it leaves out. */
const planFields = {
  code: planCode,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500),
  modules: z.array(z.enum(FEATURE_MODULE_KEYS)).max(FEATURE_MODULE_KEYS.length),
  limits: limitsSchema.partial(),
  prices: z.array(priceSchema).max(20),
  includedCreditsPerMonth: z.number().int().min(0).max(1_000_000),
  isPublic: z.boolean(),
  isActive: z.boolean(),
  trialEligible: z.boolean(),
  highlight: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
};

export const createPlanBody = z
  .object({
    ...planFields,
    description: planFields.description.default(''),
    limits: planFields.limits.default({}),
    includedCreditsPerMonth: planFields.includedCreditsPerMonth.default(0),
    isPublic: planFields.isPublic.default(true),
    isActive: planFields.isActive.default(true),
    trialEligible: planFields.trialEligible.default(true),
    highlight: planFields.highlight.default(false),
    sortOrder: planFields.sortOrder.default(100),
  })
  .strict();

export const updatePlanBody = z
  .object(planFields)
  .omit({ code: true })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const decimalRate = z.number().min(0).max(100_000).multipleOf(0.01, 'At most 2 decimals');

export const publishRateBody = z
  .object({
    currency: currencySchema,
    creditPriceMinor: z.number().int().min(1).max(1_000_000),
    tiers: z
      .array(
        z
          .object({
            tier: z.enum(MODEL_TIERS),
            inputCreditsPer1k: decimalRate,
            outputCreditsPer1k: decimalRate,
          })
          .strict(),
      )
      .min(1)
      .max(MODEL_TIERS.length),
    minimumCreditsPerRequest: decimalRate.default(1),
    /** Credits per minute of voice note turned into text; leave out to keep voice notes audio only. */
    transcriptionCreditsPerMinute: decimalRate.optional(),
    /** Credits per keyword search-volume lookup; leave out to show keyword ideas without volumes. */
    keywordLookupCredits: decimalRate.optional(),
    usdRate: z.number().positive().max(100_000).describe('Local currency per 1 USD, e.g. 122.5'),
    effectiveFrom: isoDate.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const usdPerMTok = z.number().min(0).max(10_000);

/** Catalogue fields without defaults, so a partial update never resets what it leaves out. */
const aiModelFields = {
  provider: z.enum(['anthropic', 'openai', 'google', 'other']),
  model: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(100),
  purpose: z.enum(MODEL_PURPOSES),
  tier: z.enum(MODEL_TIERS),
  inputUsdPerMTok: usdPerMTok,
  outputUsdPerMTok: usdPerMTok,
  cachedInputUsdPerMTok: usdPerMTok,
  /** null: 1.25 × the input price. */
  cacheWriteUsdPerMTok: usdPerMTok.nullable().optional(),
  longContext: z
    .object({
      thresholdTokens: z.number().int().min(1),
      inputUsdPerMTok: usdPerMTok,
      outputUsdPerMTok: usdPerMTok,
    })
    .strict()
    .nullable()
    .optional(),
  contextWindow: z.number().int().min(1_000).max(10_000_000),
  imageInput: z.boolean(),
  /** Speech-to-text models: USD per minute of audio. */
  audioUsdPerMinute: z.number().min(0).max(100).nullable().optional(),
  enabled: z.boolean(),
  isDefaultForTier: z.boolean(),
};

export const aiModelBody = z
  .object({
    ...aiModelFields,
    purpose: aiModelFields.purpose.default('chat'),
    cachedInputUsdPerMTok: aiModelFields.cachedInputUsdPerMTok.default(0),
    contextWindow: aiModelFields.contextWindow.default(200_000),
    imageInput: aiModelFields.imageInput.default(false),
    enabled: aiModelFields.enabled.default(true),
    isDefaultForTier: aiModelFields.isDefaultForTier.default(false),
  })
  .strict()
  .refine((b) => b.purpose !== 'transcription' || typeof b.audioUsdPerMinute === 'number', {
    path: ['audioUsdPerMinute'],
    message: 'A speech-to-text model needs its price per minute',
  });

export const updateAiModelBody = z
  .object(aiModelFields)
  .omit({ provider: true, model: true, purpose: true })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const gatewayParam = z.enum(GATEWAYS);

export const gatewayBody = z
  .object({
    enabled: z.boolean().optional(),
    sandbox: z.boolean().optional(),
    credentials: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const walletAdjustBody = z
  .object({
    direction: z.enum(['credit', 'debit']),
    type: z.enum(['topup', 'bonus', 'adjustment', 'refund']),
    amountMinor: positiveMinor,
    note: z.string().trim().min(3).max(500),
    idempotencyKey,
  })
  .strict();

export const walletStatusBody = z
  .object({ status: z.enum(['active', 'frozen']), note: z.string().trim().min(3).max(500) })
  .strict();

export const assignPlanBody = z
  .object({
    planCode,
    interval,
    periodEnd: isoDate.optional(),
    note: z.string().trim().min(3).max(500),
  })
  .strict();

export const extendTrialBody = z
  .object({ days: z.number().int().min(1).max(90), note: z.string().trim().min(3).max(500) })
  .strict();

export const overridesBody = z
  .object({
    addModules: z.array(z.enum(FEATURE_MODULE_KEYS)).default([]),
    removeModules: z.array(z.enum(FEATURE_MODULE_KEYS)).default([]),
    limits: limitsSchema.partial().default({}),
    expiresAt: isoDate.optional(),
    note: z.string().trim().min(3).max(500),
  })
  .strict();

export const reviewBody = z.object({ note: z.string().trim().max(500).default('') }).strict();

export const withdrawalPaidBody = z
  .object({
    note: z.string().trim().max(500).default(''),
    payoutRef: z.string().trim().min(3).max(120),
  })
  .strict();

const cursorQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: objectIdSchema.optional(),
};

export const platformPaymentsQuery = z.object({
  ...cursorQuery,
  status: z.enum(['pending', 'succeeded', 'failed', 'canceled', 'refunded']).optional(),
  gateway: z.enum(GATEWAYS).optional(),
  orgId: objectIdSchema.optional(),
});

export const platformWithdrawalsQuery = z.object({
  ...cursorQuery,
  status: z.enum(['requested', 'approved', 'paid', 'rejected', 'canceled']).optional(),
});

export const platformUsageQuery = z.object({ ...cursorQuery, orgId: objectIdSchema.optional() });

export const profitQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    groupBy: z.enum(['day', 'org', 'model', 'feature', 'tier']).default('day'),
    orgId: objectIdSchema.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, {
    message: '"from" must be before "to"',
    path: ['from'],
  });

/** Defaults a range to the last 30 days. */
export function resolveRange(q: { from?: Date; to?: Date }, days = 30): { from: Date; to: Date } {
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - days * 24 * 3600_000);
  return { from, to };
}
