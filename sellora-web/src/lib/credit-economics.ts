import type { AiModel, ModelTier } from '@/lib/api/types';
import { minorDigits } from '@/lib/format';

/** The parts of a credit price list the estimates need (works for drafts too). */
export interface RateDraft {
  currency: string;
  creditPriceMinor: number;
  minimumCreditsPerRequest: number;
  usdRate: number;
  tiers: { tier: ModelTier; inputCreditsPer1k: number; outputCreditsPer1k: number }[];
  /** Credits per minute of voice note turned into text; null or missing: no voice price. */
  transcriptionCreditsPerMinute?: number | null;
}

export interface TierEconomics {
  tier: ModelTier;
  /** What a merchant pays per million tokens, in minor units. */
  priceInputPerMMinor: number;
  priceOutputPerMMinor: number;
  /** What the provider charges us per million tokens, in minor units (most expensive enabled model). */
  costInputPerMMinor: number | null;
  costOutputPerMMinor: number | null;
  marginInputPct: number | null;
  marginOutputPct: number | null;
  model: Pick<AiModel, 'label' | 'model'> | null;
}

function margin(price: number, cost: number | null): number | null {
  if (cost === null || price <= 0) return null;
  return ((price - cost) / price) * 100;
}

/**
 * Price and cost per million tokens for each tier, so an admin sees the margin before
 * publishing a price list. Cost uses the most expensive enabled model in the tier (the
 * worst case), converted with the draft's USD rate. An estimate for review only: the API
 * bills each call with integer maths (see credit-math.ts in sellora-api).
 */
export function tierEconomics(rate: RateDraft, models: AiModel[]): TierEconomics[] {
  const scale = 10 ** minorDigits(rate.currency);
  return rate.tiers.map((t) => {
    const candidates = models.filter(
      (m) => m.enabled && m.purpose !== 'transcription' && m.tier === t.tier,
    );
    const worst = candidates.reduce<AiModel | null>(
      (w, m) =>
        !w || m.inputUsdPerMTok + m.outputUsdPerMTok > w.inputUsdPerMTok + w.outputUsdPerMTok
          ? m
          : w,
      null,
    );
    const priceIn = t.inputCreditsPer1k * 1000 * rate.creditPriceMinor;
    const priceOut = t.outputCreditsPer1k * 1000 * rate.creditPriceMinor;
    const costIn = worst ? worst.inputUsdPerMTok * rate.usdRate * scale : null;
    const costOut = worst ? worst.outputUsdPerMTok * rate.usdRate * scale : null;
    return {
      tier: t.tier,
      priceInputPerMMinor: priceIn,
      priceOutputPerMMinor: priceOut,
      costInputPerMMinor: costIn,
      costOutputPerMMinor: costOut,
      marginInputPct: margin(priceIn, costIn),
      marginOutputPct: margin(priceOut, costOut),
      model: worst ? { label: worst.label, model: worst.model } : null,
    };
  });
}

export interface VoiceEconomics {
  /** What a merchant pays per minute of recording, in minor units. */
  pricePerMinuteMinor: number;
  /** What the provider charges us per minute (most expensive enabled speech model). */
  costPerMinuteMinor: number | null;
  marginPct: number | null;
  model: Pick<AiModel, 'label' | 'model'> | null;
}

/** Price, cost and margin per minute of voice note; null when the draft has no voice price. */
export function voiceEconomics(rate: RateDraft, models: AiModel[]): VoiceEconomics | null {
  const perMinute = rate.transcriptionCreditsPerMinute;
  if (perMinute === null || perMinute === undefined) return null;
  const scale = 10 ** minorDigits(rate.currency);
  const worst = models
    .filter((m) => m.enabled && m.purpose === 'transcription')
    .reduce<AiModel | null>(
      (w, m) => (!w || (m.audioUsdPerMinute ?? 0) > (w.audioUsdPerMinute ?? 0) ? m : w),
      null,
    );
  const price = perMinute * rate.creditPriceMinor;
  const cost = worst ? (worst.audioUsdPerMinute ?? 0) * rate.usdRate * scale : null;
  return {
    pricePerMinuteMinor: price,
    costPerMinuteMinor: cost,
    marginPct: margin(price, cost),
    model: worst ? { label: worst.label, model: worst.model } : null,
  };
}

/**
 * Credits and charge for one call, mirroring the API's rounding: credits round up to the
 * next hundredth with the per-request minimum, and the charge rounds up to a minor unit.
 */
export function estimateCall(
  rate: RateDraft,
  tier: ModelTier,
  inputTokens: number,
  outputTokens: number,
): { credits: number; chargeMinor: number } | null {
  const t = rate.tiers.find((x) => x.tier === tier);
  if (!t) return null;
  const centi = (v: number) => Math.round(v * 100);
  const raw = inputTokens * centi(t.inputCreditsPer1k) + outputTokens * centi(t.outputCreditsPer1k);
  const centiCredits = Math.max(Math.ceil(raw / 1000), centi(rate.minimumCreditsPerRequest));
  return {
    credits: centiCredits / 100,
    chargeMinor: Math.ceil((centiCredits * rate.creditPriceMinor) / 100),
  };
}
