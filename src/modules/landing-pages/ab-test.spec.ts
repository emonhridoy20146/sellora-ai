import { describe, expect, it } from 'vitest';
import { abBucket, abDecision, abResult, abVariant, AB_DEFAULTS, normalCdf } from './ab-test.js';
import type { AbCounts } from './schemas.js';

const counts = (visitors: number, buyers: number): AbCounts => ({
  visitors,
  buyers,
  orders: buyers,
  revenueMinor: buyers * 100_000,
});

describe('A/B test arithmetic (ADR 0031)', () => {
  it('gives the same visitor the same version and splits visitors by the share asked', () => {
    const test = '65f0c0ffee0000000000abcd';
    expect(abBucket(test, 'visitor-aaaaaaaaaaaa')).toBe(abBucket(test, 'visitor-aaaaaaaaaaaa'));
    let b = 0;
    for (let i = 0; i < 10_000; i++) {
      const bucket = abBucket(test, `visitor-${i.toString().padStart(12, '0')}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
      if (abVariant(test, `visitor-${i.toString().padStart(12, '0')}`, 50) === 'b') b += 1;
    }
    // 50% of 10,000, give or take what chance allows (about ±1.5% at three sigma).
    expect(b).toBeGreaterThan(4_700);
    expect(b).toBeLessThan(5_300);
    expect(abVariant(test, 'visitor-aaaaaaaaaaaa', 0)).toBe('a');
    expect(abVariant(test, 'visitor-aaaaaaaaaaaa', 100)).toBe('b');
    // Another test splits the same visitors differently.
    const other = '65f0c0ffee0000000000dcba';
    let same = 0;
    for (let i = 0; i < 1_000; i++) {
      const v = `visitor-${i.toString().padStart(12, '0')}`;
      if (abVariant(test, v, 50) === abVariant(other, v, 50)) same += 1;
    }
    expect(same).toBeGreaterThan(400);
    expect(same).toBeLessThan(600);
  });

  it('computes the normal distribution', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 5);
    expect(normalCdf(3)).toBeCloseTo(0.99865, 5);
  });

  it('calls a winner only with enough visitors and 95% confidence', () => {
    // 3% against 5% on 1,000 visitors each: z ≈ 2.28, confidence ≈ 97.7%.
    const clear = abResult({ a: counts(1_000, 30), b: counts(1_000, 50) }, 300);
    expect(clear.rateA).toBeCloseTo(0.03, 6);
    expect(clear.rateB).toBeCloseTo(0.05, 6);
    expect(clear.lift).toBeCloseTo(2 / 3, 6);
    expect(clear.confidence).toBeCloseTo(0.9775, 3);
    expect(clear.leader).toBe('b');
    expect(clear.enoughVisitors).toBe(true);

    // The same when A is the better one.
    expect(abResult({ a: counts(1_000, 50), b: counts(1_000, 30) }, 300).leader).toBe('a');

    // 3% against 3.8%: z ≈ 0.99, about 68% sure, so no winner yet.
    const unsure = abResult({ a: counts(1_000, 30), b: counts(1_000, 38) }, 300);
    expect(unsure.confidence).toBeCloseTo(0.677, 2);
    expect(unsure.leader).toBeNull();

    // A big difference on too few visitors is not called.
    const few = abResult({ a: counts(200, 2), b: counts(200, 30) }, 300);
    expect(few.confidence).toBeGreaterThan(0.99);
    expect(few.enoughVisitors).toBe(false);
    expect(few.leader).toBeNull();
  });

  it('handles empty and odd counts without dividing by zero', () => {
    const empty = abResult({ a: counts(0, 0), b: counts(0, 0) }, 300);
    expect(empty).toMatchObject({
      rateA: null,
      rateB: null,
      lift: null,
      confidence: null,
      leader: null,
    });
    const noBuyers = abResult({ a: counts(500, 0), b: counts(500, 0) }, 300);
    expect(noBuyers).toMatchObject({ rateA: 0, rateB: 0, lift: null, confidence: 0, leader: null });
    // More buyers than visitors (a visit beacon lost) counts as everyone bought.
    const odd = abResult({ a: counts(10, 12), b: counts(10, 5) }, 1);
    expect(odd.rateA).toBe(1);
  });

  it('decides when an automatic test ends', () => {
    const start = new Date('2026-11-01T00:00:00Z');
    const day = 86_400_000;
    const winning = { a: counts(1_000, 30), b: counts(1_000, 50) };
    const even = { a: counts(1_000, 30), b: counts(1_000, 31) };
    expect(abDecision(winning, AB_DEFAULTS, start, new Date(start.getTime() + day))).toEqual({
      end: true,
      winner: 'b',
      reason: 'auto_winner',
    });
    expect(abDecision(even, AB_DEFAULTS, start, new Date(start.getTime() + 13 * day))).toEqual({
      end: false,
    });
    expect(abDecision(even, AB_DEFAULTS, start, new Date(start.getTime() + 14 * day))).toEqual({
      end: true,
      winner: 'a',
      reason: 'no_clear_winner',
    });
    // A test the business ends by hand never ends by itself.
    const manual = { ...AB_DEFAULTS, autoWinner: false };
    expect(abDecision(winning, manual, start, new Date(start.getTime() + 30 * day))).toEqual({
      end: false,
    });
  });
});
