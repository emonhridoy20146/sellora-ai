import { createHash } from 'node:crypto';
import type { AbCounts, AbTestSettings } from './schemas.js';

/**
 * A/B test arithmetic (ADR 0031), pure so it is unit-tested: which version a visitor sees,
 * and whether one version is clearly better.
 */

export const AB_DEFAULTS: AbTestSettings = {
  splitB: 50,
  autoWinner: true,
  minVisitors: 300,
  maxDays: 14,
};

/** How sure the test must be before a winner is called: 95%. */
export const AB_CONFIDENCE = 0.95;

/** The browser's A/B id (a random cookie the storefront sets). */
export const AB_VISITOR_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** 0–99 for this visitor in this test; the same visitor always gets the same number. */
export function abBucket(testId: string, visitor: string): number {
  const h = createHash('sha256').update(`${testId}:${visitor}`).digest();
  return h.readUInt32BE(0) % 100;
}

/** The version this visitor sees: B for the first `splitB` buckets. */
export function abVariant(testId: string, visitor: string, splitB: number): 'a' | 'b' {
  return abBucket(testId, visitor) < splitB ? 'b' : 'a';
}

/** The standard normal distribution's CDF (Abramowitz and Stegun 7.1.26, error < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export interface AbResult {
  rateA: number | null;
  rateB: number | null;
  /** B against A: 0.2 means B converts 20% better. Null without A's buyers. */
  lift: number | null;
  /** 1 − the two-sided p-value of a two-proportion z-test; null without enough data. */
  confidence: number | null;
  /** The better version once the test is sure, else null. */
  leader: 'a' | 'b' | null;
  /** Both versions have at least `minVisitors` visitors. */
  enoughVisitors: boolean;
}

/** Conversion of each version (buyers per visitor) and how sure the difference is. */
export function abResult(counts: { a: AbCounts; b: AbCounts }, minVisitors: number): AbResult {
  const { a, b } = counts;
  const rate = (c: AbCounts) =>
    c.visitors > 0 ? Math.min(c.buyers, c.visitors) / c.visitors : null;
  const rateA = rate(a);
  const rateB = rate(b);
  const lift = rateA && rateB !== null ? rateB / rateA - 1 : null;
  let confidence: number | null = null;
  if (a.visitors > 0 && b.visitors > 0) {
    const ba = Math.min(a.buyers, a.visitors);
    const bb = Math.min(b.buyers, b.visitors);
    const pooled = (ba + bb) / (a.visitors + b.visitors);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.visitors + 1 / b.visitors));
    if (se > 0) {
      const z = (rateB! - rateA!) / se;
      confidence = 1 - 2 * (1 - normalCdf(Math.abs(z)));
    } else confidence = 0;
  }
  const enoughVisitors = a.visitors >= minVisitors && b.visitors >= minVisitors;
  const leader =
    enoughVisitors && confidence !== null && confidence >= AB_CONFIDENCE && rateA !== rateB
      ? rateB! > rateA!
        ? 'b'
        : 'a'
      : null;
  return { rateA, rateB, lift, confidence, leader, enoughVisitors };
}

/**
 * What an automatic test does now: keep running, make a winner live, or stop without a
 * clear winner (A stays) once its days are over.
 */
export function abDecision(
  counts: { a: AbCounts; b: AbCounts },
  settings: AbTestSettings,
  startedAt: Date,
  now: Date,
): { end: false } | { end: true; winner: 'a' | 'b'; reason: 'auto_winner' | 'no_clear_winner' } {
  if (!settings.autoWinner) return { end: false };
  const r = abResult(counts, settings.minVisitors);
  if (r.leader) return { end: true, winner: r.leader, reason: 'auto_winner' };
  if (now.getTime() - startedAt.getTime() >= settings.maxDays * 86_400_000)
    return { end: true, winner: 'a', reason: 'no_clear_winner' };
  return { end: false };
}
