import { describe, expect, it } from 'vitest';
import {
  codeProblem,
  couponProblem,
  couponState,
  couponValue,
  normalizeCode,
  type CouponTerms,
} from './coupon-rules.js';

const base: CouponTerms = {
  active: true,
  kind: 'percent',
  percent: 10,
  amountMinor: null,
  maxDiscountMinor: null,
  minOrderMinor: 0,
  startsAt: null,
  endsAt: null,
  usageLimit: null,
  used: 0,
  store: true,
  landing: 'all',
  landingPageIds: [],
};
const now = new Date('2026-11-12T10:00:00Z');
const store = { type: 'store' } as const;
const order = { goodsMinor: 99_900, deliveryChargeMinor: 12_000 };

describe('coupon codes', () => {
  it('stores codes in upper case without spaces, and checks their shape', () => {
    expect(normalizeCode(' eid 10 ')).toBe('EID10');
    expect(codeProblem('EID10')).toBeNull();
    expect(codeProblem('EID-2026')).toBeNull();
    for (const bad of ['AB', 'A--B', 'ABC-', '-ABC', 'TAKA৳', 'X'.repeat(21)])
      expect(codeProblem(bad)).not.toBeNull();
  });
});

describe('what a coupon takes off', () => {
  it('rounds percentages down to whole taka and holds them to the cap', () => {
    expect(couponValue(base, order)).toEqual({ discountMinor: 9_900, freeDelivery: false });
    expect(couponValue({ ...base, maxDiscountMinor: 5_000 }, order).discountMinor).toBe(5_000);
    expect(
      couponValue({ ...base, percent: 15 }, { goodsMinor: 33_350, deliveryChargeMinor: 0 }),
    ).toEqual({ discountMinor: 5_000, freeDelivery: false });
  });

  it('never takes more than the goods cost', () => {
    const amount = { ...base, kind: 'amount' as const, percent: null, amountMinor: 50_000 };
    expect(
      couponValue(amount, { goodsMinor: 30_000, deliveryChargeMinor: 6_000 }).discountMinor,
    ).toBe(30_000);
  });

  it('waives the delivery charge for free-delivery coupons', () => {
    const free = { ...base, kind: 'free_delivery' as const, percent: null };
    expect(couponValue(free, order)).toEqual({ discountMinor: 0, freeDelivery: true });
    expect(couponProblem(free, store, { goodsMinor: 1_000, deliveryChargeMinor: 0 }, now)).toBe(
      'no_saving',
    );
  });
});

describe('why a coupon cannot be used', () => {
  it('checks switch, dates, uses, place and minimum, in that order', () => {
    expect(couponProblem(base, store, order, now)).toBeNull();
    expect(couponProblem({ ...base, active: false }, store, order, now)).toBe('invalid');
    expect(couponProblem({ ...base, startsAt: new Date('2026-11-13') }, store, order, now)).toBe(
      'not_started',
    );
    expect(couponProblem({ ...base, endsAt: now }, store, order, now)).toBe('ended');
    expect(couponProblem({ ...base, usageLimit: 3, used: 3 }, store, order, now)).toBe('used_up');
    expect(couponProblem({ ...base, store: false }, store, order, now)).toBe('not_here');
    expect(couponProblem({ ...base, minOrderMinor: 100_000 }, store, order, now)).toBe('min_order');
  });

  it('works on all landing pages, chosen ones or none', () => {
    const page = { type: 'landing', pageId: 'p1' } as const;
    expect(couponProblem(base, page, order, now)).toBeNull();
    expect(couponProblem({ ...base, landing: 'none' }, page, order, now)).toBe('not_here');
    expect(
      couponProblem({ ...base, landing: 'chosen', landingPageIds: ['p2'] }, page, order, now),
    ).toBe('not_here');
    expect(
      couponProblem({ ...base, landing: 'chosen', landingPageIds: ['p1'] }, page, order, now),
    ).toBeNull();
  });

  it('says where a coupon stands for the dashboard', () => {
    expect(couponState(base, now)).toBe('active');
    expect(couponState({ ...base, startsAt: new Date('2026-12-01') }, now)).toBe('scheduled');
    expect(couponState({ ...base, endsAt: new Date('2026-11-01') }, now)).toBe('ended');
    expect(couponState({ ...base, usageLimit: 1, used: 1 }, now)).toBe('used_up');
    expect(couponState({ ...base, active: false }, now)).toBe('off');
  });
});
