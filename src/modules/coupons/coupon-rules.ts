/**
 * Coupon rules as pure functions (ADR 0031), so what a code is worth and why it cannot be
 * used are unit-tested apart from the database.
 */

export const COUPON_KINDS = ['percent', 'amount', 'free_delivery'] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

/** Where a coupon may be used on landing pages: all of them, chosen ones, or none. */
export const COUPON_LANDING_SCOPES = ['all', 'chosen', 'none'] as const;
export type CouponLandingScope = (typeof COUPON_LANDING_SCOPES)[number];

/** Coupons per business. */
export const MAX_COUPONS = 200;
/** The largest percentage a coupon may take off. */
export const MAX_PERCENT = 90;

/** Why a shopper cannot use a code. `invalid` covers unknown, switched off and removed. */
export const COUPON_REASONS = [
  'invalid',
  'not_started',
  'ended',
  'used_up',
  'not_here',
  'min_order',
  'customer_limit',
  'no_saving',
] as const;
export type CouponReason = (typeof COUPON_REASONS)[number];

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,19}$/;

/** A code as stored and compared: upper case, no spaces. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/** Why a code cannot be used as a coupon code, or null. */
export function codeProblem(code: string): string | null {
  if (!CODE_RE.test(code) || code.includes('--') || code.endsWith('-'))
    return 'Use 3 to 20 letters, numbers and single hyphens';
  return null;
}

/** The parts of a coupon its rules read. */
export interface CouponTerms {
  active: boolean;
  kind: CouponKind;
  percent?: number | null;
  amountMinor?: number | null;
  maxDiscountMinor?: number | null;
  minOrderMinor: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
  usageLimit?: number | null;
  used: number;
  store: boolean;
  landing: CouponLandingScope;
  landingPageIds: string[];
}

/** Where the shopper is ordering. */
export type CouponPlace = { type: 'store' } | { type: 'landing'; pageId: string };

/** What the shopper's order is worth before the coupon. */
export interface CouponOrder {
  /** Goods after package savings, before delivery. */
  goodsMinor: number;
  deliveryChargeMinor: number;
}

export interface CouponValue {
  /** Taken off the goods. */
  discountMinor: number;
  /** The delivery charge is waived. */
  freeDelivery: boolean;
}

/**
 * What the coupon takes off this order. Percentages round down to whole currency units
 * (shops in Bangladesh price in whole taka) and never take more than the goods cost.
 */
export function couponValue(c: CouponTerms, order: CouponOrder): CouponValue {
  const goods = Math.max(0, order.goodsMinor);
  switch (c.kind) {
    case 'percent': {
      let d = Math.floor((goods * (c.percent ?? 0)) / 100 / 100) * 100;
      if (c.maxDiscountMinor) d = Math.min(d, c.maxDiscountMinor);
      return { discountMinor: Math.min(d, goods), freeDelivery: false };
    }
    case 'amount':
      return { discountMinor: Math.min(c.amountMinor ?? 0, goods), freeDelivery: false };
    case 'free_delivery':
      return { discountMinor: 0, freeDelivery: true };
  }
}

/** Whether the coupon may be used at this place at all. */
export function couponAppliesAt(c: CouponTerms, place: CouponPlace): boolean {
  if (place.type === 'store') return c.store;
  if (c.landing === 'all') return true;
  if (c.landing === 'chosen') return c.landingPageIds.includes(place.pageId);
  return false;
}

/**
 * Why the coupon cannot be used on this order right now, or null when it can. The
 * per-customer limit is checked separately, when the phone number is known.
 */
export function couponProblem(
  c: CouponTerms,
  place: CouponPlace,
  order: CouponOrder,
  now: Date,
): CouponReason | null {
  if (!c.active) return 'invalid';
  if (c.startsAt && c.startsAt > now) return 'not_started';
  if (c.endsAt && c.endsAt <= now) return 'ended';
  if (c.usageLimit != null && c.used >= c.usageLimit) return 'used_up';
  if (!couponAppliesAt(c, place)) return 'not_here';
  if (c.minOrderMinor > 0 && order.goodsMinor < c.minOrderMinor) return 'min_order';
  const v = couponValue(c, order);
  if (v.discountMinor === 0 && !(v.freeDelivery && order.deliveryChargeMinor > 0))
    return 'no_saving';
  return null;
}

/** Shopper-facing words for a reason, in English (the storefront has its own translations). */
export const COUPON_REASON_TEXT: Record<CouponReason, string> = {
  invalid: 'This code is not valid.',
  not_started: 'This code cannot be used yet.',
  ended: 'This code has ended.',
  used_up: 'This code has been used up.',
  not_here: 'This code cannot be used here.',
  min_order: 'Spend a little more to use this code.',
  customer_limit: 'You have already used this code.',
  no_saving: 'This code does not lower this order.',
};

/** Where the coupon's status stands for the dashboard. */
export type CouponState = 'active' | 'scheduled' | 'ended' | 'used_up' | 'off';

export function couponState(c: CouponTerms, now: Date): CouponState {
  if (!c.active) return 'off';
  if (c.endsAt && c.endsAt <= now) return 'ended';
  if (c.usageLimit != null && c.used >= c.usageLimit) return 'used_up';
  if (c.startsAt && c.startsAt > now) return 'scheduled';
  return 'active';
}

/** Distinct codes one shopper address may try within `COUPON_TRY_WINDOW_S` before waiting. */
export const COUPON_TRY_WINDOW_S = 600;
