import type { Dictionary } from './i18n';
import type { CouponCheck, CouponReason, Problem } from './types';

const REASONS: ReadonlySet<string> = new Set<CouponReason>([
  'invalid',
  'not_started',
  'ended',
  'used_up',
  'not_here',
  'min_order',
  'customer_limit',
  'no_saving',
]);

/** A code as the API compares it: upper case, no spaces. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/** Why a code does not work, in the page's language (the API's own words are English). */
export function couponRefusal(
  c: { reason: string; minOrderMinor?: number | undefined },
  t: Dictionary,
  money: (minor: number) => string,
): string {
  if (c.reason === 'min_order' && typeof c.minOrderMinor === 'number' && c.minOrderMinor > 0)
    return t.couponMinOrder(money(c.minOrderMinor));
  return REASONS.has(c.reason) ? t.couponReason[c.reason as CouponReason] : t.couponReason.invalid;
}

/** The refusal in a checked code's answer. */
export function checkRefusal(
  check: Extract<CouponCheck, { valid: false }>,
  t: Dictionary,
  money: (minor: number) => string,
): string {
  return couponRefusal(check, t, money);
}

/**
 * The shopper's words for a failed request about a code: too many codes tried, the order's
 * `coupon_invalid` (the code stopped working since it was applied), or the problem's detail.
 */
export function couponProblemText(
  p: Problem,
  t: Dictionary,
  money: (minor: number) => string,
): string {
  if (p.status === 429) return t.couponTooMany;
  if (p.code === 'coupon_invalid' && typeof p.reason === 'string')
    return couponRefusal(
      {
        reason: p.reason,
        minOrderMinor: typeof p.minOrderMinor === 'number' ? p.minOrderMinor : undefined,
      },
      t,
      money,
    );
  return p.detail;
}
