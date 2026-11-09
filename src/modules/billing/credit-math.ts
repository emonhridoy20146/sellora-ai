import { currencyInfo, mulDiv } from '../../common/money/money.js';
import type { AiModel, CreditRate, ModelTier } from './credit-schemas.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's cache (billed by the provider at a discount). */
  cachedInputTokens?: number;
  /** Prompt tokens written to the provider's cache (billed by the provider at a premium). */
  cacheWriteInputTokens?: number;
}

export interface CreditCharge {
  /** Credits with two decimals, e.g. 12.35. */
  credits: number;
  /** Hundredths of a credit, the integer the maths is done in. */
  centiCredits: number;
  /** What the merchant pays, in minor units of the rate's currency. */
  billedMinor: number;
}

/** Rates are stored as decimals (2.5 credits per 1K); the maths runs on integers ×100. */
function centi(value: number): number {
  return Math.round(value * 100);
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Every prompt token of a call: plain, read from the cache and written to it. */
export function promptTokens(usage: TokenUsage): number {
  return (
    Math.max(0, usage.inputTokens) +
    Math.max(0, usage.cachedInputTokens ?? 0) +
    Math.max(0, usage.cacheWriteInputTokens ?? 0)
  );
}

/**
 * Credits for one AI call. Every prompt token (cached or not) is charged at the tier's
 * input rate, so merchants see one simple price; provider caching only changes our cost.
 * Rounded up to the next hundredth of a credit, with the per-request minimum applied.
 */
export function creditsFor(rate: CreditRate, tier: ModelTier, usage: TokenUsage): CreditCharge {
  const tierRate = rate.tiers.find((t) => t.tier === tier);
  if (!tierRate) throw new Error(`Credit rate v${rate.version} has no "${tier}" tier`);
  const input = BigInt(promptTokens(usage));
  const output = BigInt(Math.max(0, usage.outputTokens));
  // tokens × (centi-credits per 1K) / 1000 = centi-credits
  const raw =
    input * BigInt(centi(tierRate.inputCreditsPer1k)) +
    output * BigInt(centi(tierRate.outputCreditsPer1k));
  const minimum = BigInt(centi(rate.minimumCreditsPerRequest));
  let centiCredits = ceilDiv(raw, 1000n);
  if (centiCredits < minimum) centiCredits = minimum;
  const billed = ceilDiv(centiCredits * BigInt(rate.creditPriceMinor), 100n);
  return {
    credits: Number(centiCredits) / 100,
    centiCredits: Number(centiCredits),
    billedMinor: Number(billed),
  };
}

/** Providers charge a quarter more than the input price to write the cache, unless the catalogue says otherwise. */
const CACHE_WRITE_PREMIUM = 1.25;

/** What we pay the provider, in micro-USD (1 USD = 1,000,000). */
export function providerCostUsdMicros(model: AiModel, usage: TokenUsage): number {
  const long = model.longContext && promptTokens(usage) > model.longContext.thresholdTokens;
  const inPrice = long ? model.longContext!.inputUsdMicrosPerMTok : model.inputUsdMicrosPerMTok;
  const outPrice = long ? model.longContext!.outputUsdMicrosPerMTok : model.outputUsdMicrosPerMTok;
  const writePrice =
    !long && model.cacheWriteUsdMicrosPerMTok !== undefined
      ? model.cacheWriteUsdMicrosPerMTok
      : Math.ceil(inPrice * CACHE_WRITE_PREMIUM);
  const total =
    BigInt(Math.max(0, usage.inputTokens)) * BigInt(inPrice) +
    BigInt(Math.max(0, usage.outputTokens)) * BigInt(outPrice) +
    BigInt(Math.max(0, usage.cachedInputTokens ?? 0)) * BigInt(model.cachedInputUsdMicrosPerMTok) +
    BigInt(Math.max(0, usage.cacheWriteInputTokens ?? 0)) * BigInt(writePrice);
  // price is per million tokens; round up so cost is never understated
  return Number(ceilDiv(total, 1_000_000n));
}

/** Converts micro-USD to minor units of the rate's currency using the platform FX rate. */
export function usdMicrosToMinor(
  usdMicros: number,
  rate: Pick<CreditRate, 'usdRateScaled' | 'currency'>,
): number {
  const { minorUnits } = currencyInfo(rate.currency);
  // micros / 1e6 USD × (scaled / 1e4) local × 10^minorUnits
  return mulDiv(usdMicros, rate.usdRateScaled * 10 ** minorUnits, 10_000_000_000);
}

/** Worst-case charge for a call, used to reserve funds before calling the provider. */
export function maxChargeFor(
  rate: CreditRate,
  tier: ModelTier,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): CreditCharge {
  return creditsFor(rate, tier, {
    inputTokens: estimatedInputTokens,
    outputTokens: maxOutputTokens,
  });
}

/**
 * Credits for turning a voice note into text (ADR 0025): the rate's per-minute price,
 * charged by the millisecond and rounded up to the next hundredth of a credit, with the
 * per-request minimum applied. Throws when the rate has no voice note price.
 */
export function creditsForAudio(rate: CreditRate, audioMs: number): CreditCharge {
  if (rate.transcriptionCreditsPerMinute === undefined)
    throw new Error(`Credit rate v${rate.version} has no voice note price`);
  const ms = BigInt(Math.max(0, Math.ceil(audioMs)));
  // ms × (centi-credits per minute) / 60,000 = centi-credits
  let centiCredits = ceilDiv(ms * BigInt(centi(rate.transcriptionCreditsPerMinute)), 60_000n);
  const minimum = BigInt(centi(rate.minimumCreditsPerRequest));
  if (centiCredits < minimum) centiCredits = minimum;
  const billed = ceilDiv(centiCredits * BigInt(rate.creditPriceMinor), 100n);
  return {
    credits: Number(centiCredits) / 100,
    centiCredits: Number(centiCredits),
    billedMinor: Number(billed),
  };
}

/** What the speech-to-text provider charges for `audioMs` of audio, in micro-USD (rounded up). */
export function providerAudioCostUsdMicros(model: AiModel, audioMs: number): number {
  const perMinute = BigInt(model.audioUsdMicrosPerMinute ?? 0);
  return Number(ceilDiv(BigInt(Math.max(0, Math.ceil(audioMs))) * perMinute, 60_000n));
}
