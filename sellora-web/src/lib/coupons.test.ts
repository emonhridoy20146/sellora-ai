import { describe, expect, it } from 'vitest';
import type { Coupon } from './api/types';
import {
  couponChanges,
  couponFormToBody,
  couponToForm,
  couponValueText,
  couponWhereText,
  emptyCouponForm,
} from './coupons';

const now = Date.UTC(2026, 10, 12, 6, 0);

const saved: Coupon = {
  id: 'c1',
  code: 'EID20',
  note: '',
  kind: 'percent',
  percent: 20,
  amountMinor: null,
  maxDiscountMinor: 50_000,
  minOrderMinor: 100_000,
  startsAt: null,
  endsAt: '2026-11-01T18:00:00.000Z',
  usageLimit: 100,
  perCustomerLimit: 1,
  store: true,
  landing: 'chosen',
  landingPageIds: ['p1'],
  active: true,
  used: 4,
  discountGivenMinor: 80_000,
  state: 'ended',
  createdAt: '2026-10-01T00:00:00.000Z',
};

describe('coupon words', () => {
  it('say what it gives and where', () => {
    expect(couponValueText(saved, 'BDT')).toMatch(
      /^20% off \(up to .*500.*\) on orders of .*1,000/,
    );
    expect(couponValueText({ ...saved, kind: 'free_delivery', minOrderMinor: 0 }, 'BDT')).toBe(
      'Free delivery',
    );
    expect(couponWhereText(saved, [{ id: 'p1', name: 'Aloe offer' }])).toBe('Store and Aloe offer');
    expect(couponWhereText({ ...saved, store: false, landing: 'all' })).toBe('All landing pages');
    expect(couponWhereText({ ...saved, landing: 'none' })).toBe('Store only');
  });
});

describe('coupon form', () => {
  it('builds the API body and normalizes the code', () => {
    const { body, errors } = couponFormToBody(
      {
        ...emptyCouponForm(),
        code: ' eid 20 ',
        percent: '20',
        maxDiscount: '500',
        minOrder: '1,000',
      },
      'BDT',
      { now },
    );
    expect(errors).toEqual({});
    expect(body).toMatchObject({
      code: 'EID20',
      kind: 'percent',
      percent: 20,
      maxDiscountMinor: 50_000,
      minOrderMinor: 100_000,
      amountMinor: null,
      perCustomerLimit: 1,
      usageLimit: null,
      landingPageIds: [],
    });
  });

  it('finds the same problems the API does, on the same fields', () => {
    const { body, errors } = couponFormToBody(
      {
        ...emptyCouponForm(),
        code: 'x',
        percent: '95',
        endsAt: '2026-11-01T10:00',
        usageLimit: '1.5',
        store: false,
        landing: 'none',
      },
      'BDT',
      { now },
    );
    expect(body).toBeNull();
    expect(Object.keys(errors).sort()).toEqual([
      'code',
      'endsAt',
      'percent',
      'store',
      'usageLimit',
    ]);
    expect(
      couponFormToBody({ ...emptyCouponForm(), code: 'SAVE', kind: 'amount' }, 'BDT', { now })
        .errors,
    ).toEqual({ amountMinor: 'Say how much it takes off.' });
    expect(
      couponFormToBody({ ...emptyCouponForm(), code: 'SAVE', landing: 'chosen' }, 'BDT', { now })
        .errors,
    ).toEqual({ landingPageIds: 'Choose at least one landing page.' });
  });

  it('sends only what changed, and lets an ended coupon keep its end', () => {
    const form = couponToForm(saved, 'BDT');
    const { body, errors } = couponFormToBody({ ...form, note: 'Eid' }, 'BDT', {
      now,
      savedEndsAt: saved.endsAt,
    });
    expect(errors).toEqual({});
    expect(couponChanges(saved, body!)).toEqual({ note: 'Eid' });
    const off = couponFormToBody({ ...form, active: false }, 'BDT', {
      now,
      savedEndsAt: saved.endsAt,
    });
    expect(couponChanges(saved, off.body!)).toEqual({ active: false });
  });
});
