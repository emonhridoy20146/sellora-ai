import { describe, expect, it } from 'vitest';
import type { AiModel } from '@/lib/api/types';
import { estimateCall, tierEconomics, voiceEconomics, type RateDraft } from './credit-economics';

const rate: RateDraft = {
  currency: 'BDT',
  creditPriceMinor: 100, // ৳1 per credit
  minimumCreditsPerRequest: 1,
  usdRate: 120,
  tiers: [{ tier: 'standard', inputCreditsPer1k: 0.5, outputCreditsPer1k: 2.5 }],
};

function model(over: Partial<AiModel>): AiModel {
  return {
    id: 'm',
    provider: 'other',
    model: 'test-model',
    label: 'Test',
    tier: 'standard',
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    cachedInputUsdPerMTok: 0.3,
    cacheWriteUsdPerMTok: null,
    longContext: null,
    contextWindow: 200_000,
    imageInput: true,
    enabled: true,
    isDefaultForTier: true,
    purpose: 'chat',
    audioUsdPerMinute: null,
    ...over,
  };
}

describe('tierEconomics', () => {
  it('compares price and provider cost per million tokens', () => {
    const [t] = tierEconomics(rate, [model({})]);
    // 0.5 credits per 1K × 1000 × 100 minor = 50,000 minor (৳500) per 1M input tokens
    expect(t!.priceInputPerMMinor).toBe(50_000);
    // $3 × 120 = ৳360 = 36,000 minor
    expect(t!.costInputPerMMinor).toBe(36_000);
    expect(t!.marginInputPct).toBeCloseTo(28, 5);
    expect(t!.marginOutputPct).toBeCloseTo(28, 5);
  });

  it('uses the most expensive enabled model and ignores disabled ones', () => {
    const [t] = tierEconomics(rate, [
      model({ id: 'a', label: 'Cheap', inputUsdPerMTok: 1, outputUsdPerMTok: 5 }),
      model({ id: 'b', label: 'Dear', inputUsdPerMTok: 5, outputUsdPerMTok: 25 }),
      model({ id: 'c', label: 'Off', inputUsdPerMTok: 50, outputUsdPerMTok: 250, enabled: false }),
    ]);
    expect(t!.model?.label).toBe('Dear');
  });

  it('leaves speech-to-text models out of the token tiers', () => {
    const [t] = tierEconomics(rate, [
      model({ label: 'Chat' }),
      model({
        label: 'Speech',
        purpose: 'transcription',
        inputUsdPerMTok: 0,
        outputUsdPerMTok: 99,
      }),
    ]);
    expect(t!.model?.label).toBe('Chat');
  });

  it('reports no margin when the tier has no model', () => {
    const [t] = tierEconomics(rate, []);
    expect(t!.costInputPerMMinor).toBeNull();
    expect(t!.marginInputPct).toBeNull();
  });
});

describe('estimateCall', () => {
  it('rounds credits up and applies the minimum', () => {
    expect(estimateCall(rate, 'standard', 10, 0)).toEqual({ credits: 1, chargeMinor: 100 });
    // 3000 × 50 + 400 × 250 = 250,000 centi-credit-tokens / 1000 = 250 centi = 2.5 credits
    expect(estimateCall(rate, 'standard', 3000, 400)).toEqual({ credits: 2.5, chargeMinor: 250 });
    expect(estimateCall(rate, 'fast', 1, 1)).toBeNull();
  });
});

describe('voiceEconomics', () => {
  const speech = (over: Partial<AiModel>) =>
    model({ purpose: 'transcription', label: 'Speech', audioUsdPerMinute: 0.003, ...over });

  it('compares the price per minute with the dearest enabled speech model', () => {
    const v = voiceEconomics({ ...rate, transcriptionCreditsPerMinute: 1.5 }, [
      model({}),
      speech({ label: 'Cheap', audioUsdPerMinute: 0.003 }),
      speech({ label: 'Dear', audioUsdPerMinute: 0.006 }),
      speech({ label: 'Off', audioUsdPerMinute: 1, enabled: false }),
    ])!;
    // 1.5 credits × 100 minor = 150 minor (৳1.50) per minute
    expect(v.pricePerMinuteMinor).toBe(150);
    // $0.006 × 120 × 100 = 72 minor
    expect(v.costPerMinuteMinor).toBeCloseTo(72, 5);
    expect(v.marginPct).toBeCloseTo(52, 5);
    expect(v.model?.label).toBe('Dear');
  });

  it('is empty without a voice price and has no margin without a model', () => {
    expect(voiceEconomics(rate, [speech({})])).toBeNull();
    const v = voiceEconomics({ ...rate, transcriptionCreditsPerMinute: 2 }, [model({})])!;
    expect(v.costPerMinuteMinor).toBeNull();
    expect(v.marginPct).toBeNull();
  });
});
