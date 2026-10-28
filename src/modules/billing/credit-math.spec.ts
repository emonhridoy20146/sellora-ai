import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_MODELS, DEFAULT_CREDIT_RATE } from './billing-defaults.js';
import {
  creditsFor,
  maxChargeFor,
  providerCostUsdMicros,
  usdMicrosToMinor,
} from './credit-math.js';
import type { CreditRate } from './credit-schemas.js';

const rate: CreditRate = { ...DEFAULT_CREDIT_RATE, effectiveFrom: new Date(0), createdBy: 'test' };
const model = (name: string) => DEFAULT_AI_MODELS.find((m) => m.model === name)!;

describe('AI credit maths', () => {
  it('charges input and output tokens at the tier rate, rounded up to a hundredth of a credit', () => {
    // standard: 6 credits / 1K input, 30 / 1K output
    expect(creditsFor(rate, 'standard', { inputTokens: 800, outputTokens: 200 })).toEqual({
      credits: 10.8,
      centiCredits: 1080,
      billedMinor: 108,
    });
    // 1 input token = 0.006 credits -> rounds up to 0.01, then the 1 credit minimum applies
    expect(creditsFor(rate, 'standard', { inputTokens: 1, outputTokens: 0 }).credits).toBe(1);
    // 333 fast input tokens = 0.666 credits -> 0.67; minimum 1
    expect(
      creditsFor({ ...rate, minimumCreditsPerRequest: 0 }, 'fast', {
        inputTokens: 333,
        outputTokens: 0,
      }).centiCredits,
    ).toBe(67);
  });

  it('charges cached prompt tokens like normal input, so merchants see one price', () => {
    const plain = creditsFor(rate, 'fast', { inputTokens: 2_000, outputTokens: 100 });
    const cached = creditsFor(rate, 'fast', {
      inputTokens: 500,
      cachedInputTokens: 1_500,
      outputTokens: 100,
    });
    expect(cached).toEqual(plain);
  });

  it('rounds the taka amount up and never down', () => {
    // 1.01 credits at 10 minor per credit = 10.1 -> 11 minor
    const odd = {
      ...rate,
      minimumCreditsPerRequest: 0,
      tiers: [{ tier: 'fast' as const, inputCreditsPer1k: 1.01, outputCreditsPer1k: 0 }],
    };
    expect(creditsFor(odd, 'fast', { inputTokens: 1_000, outputTokens: 0 }).billedMinor).toBe(11);
  });

  it('long messages cost more than short ones', () => {
    const short = creditsFor(rate, 'standard', { inputTokens: 300, outputTokens: 80 });
    const long = creditsFor(rate, 'standard', { inputTokens: 6_000, outputTokens: 900 });
    expect(long.billedMinor).toBeGreaterThan(short.billedMinor);
  });

  it('reserves the worst case: estimated prompt plus the full output budget', () => {
    expect(maxChargeFor(rate, 'standard', 1_000, 500).billedMinor).toBe(210);
  });

  it('rejects a tier the price list does not have', () => {
    expect(() =>
      creditsFor({ ...rate, tiers: [] }, 'fast', { inputTokens: 1, outputTokens: 1 }),
    ).toThrow(/no "fast" tier/);
  });

  it('computes real provider cost in micro-USD from per-million prices, rounding up', () => {
    // Sonnet 5.5: $2 in, $10 out, $0.20 cache read per MTok
    expect(
      providerCostUsdMicros(model('claude-sonnet-5-5'), { inputTokens: 800, outputTokens: 200 }),
    ).toBe(3_600);
    expect(
      providerCostUsdMicros(model('claude-sonnet-5-5'), {
        inputTokens: 0,
        cachedInputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(200_000);
    // 1 Haiku input token = 0.1 micro-USD -> rounds up to 1
    expect(
      providerCostUsdMicros(model('claude-haiku-5-5'), { inputTokens: 1, outputTokens: 0 }),
    ).toBe(1);
  });

  it('prices cache writes at the catalogue price, or 1.25 × input when none is set', () => {
    const sonnet = model('claude-sonnet-5-5');
    // explicit: $2.50 per MTok
    expect(
      providerCostUsdMicros(sonnet, {
        inputTokens: 0,
        cacheWriteInputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(2_500_000);
    const { cacheWriteUsdMicrosPerMTok: _, ...noWritePrice } = sonnet;
    expect(
      providerCostUsdMicros(noWritePrice, {
        inputTokens: 0,
        cacheWriteInputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(2_500_000);
    // merchants pay cache writes like any other prompt token
    expect(
      creditsFor(rate, 'standard', { inputTokens: 200, cacheWriteInputTokens: 800, outputTokens: 0 }),
    ).toEqual(creditsFor(rate, 'standard', { inputTokens: 1_000, outputTokens: 0 }));
  });

  it('counts cache reads and writes towards the long-context threshold', () => {
    const haiku = model('claude-haiku-5-5');
    const usage = { inputTokens: 1, cachedInputTokens: 60_000, cacheWriteInputTokens: 40_000, outputTokens: 0 };
    // 100,001 prompt tokens: long-context prices; writes at 1.25 × the long input price
    expect(providerCostUsdMicros(haiku, usage)).toBe(
      Math.ceil((1 * 500_000 + 60_000 * 100_000 + 40_000 * 625_000) / 1_000_000),
    );
  });

  it('switches to long-context prices above the threshold', () => {
    const haiku = model('claude-haiku-5-5');
    const below = providerCostUsdMicros(haiku, { inputTokens: 100_000, outputTokens: 1_000 });
    const above = providerCostUsdMicros(haiku, { inputTokens: 100_001, outputTokens: 1_000 });
    expect(below).toBe(10_000 + 500);
    expect(above).toBe(Math.ceil((100_001 * 500_000 + 1_000 * 2_500_000) / 1_000_000));
  });

  it('converts micro-USD to taka minor units at the platform rate (half-up)', () => {
    expect(usdMicrosToMinor(1_000_000, rate)).toBe(12_200); // $1 = ৳122.00
    expect(usdMicrosToMinor(3_600, rate)).toBe(44); // ৳0.4392 -> 44 poisha
    expect(usdMicrosToMinor(0, rate)).toBe(0);
  });

  it('keeps a healthy margin on every default tier', () => {
    for (const m of DEFAULT_AI_MODELS) {
      const usage = { inputTokens: 3_000, outputTokens: 400 };
      const billed = creditsFor(rate, m.tier, usage).billedMinor;
      const cost = usdMicrosToMinor(providerCostUsdMicros(m, usage), rate);
      expect(billed, m.model).toBeGreaterThan(cost * 1.5);
    }
  });
});
