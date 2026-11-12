import { describe, expect, it } from 'vitest';
import { mayBeLandingPath, newAbId, validAbId } from './ab';
import { couponProblemText, couponRefusal, normalizeCode } from './coupon';
import { dictionary } from './i18n';

const en = dictionary('en');
const bn = dictionary('bn');
const money = (m: number) => `৳${m / 100}`;

describe('coupon words', () => {
  it('normalizes codes the way the API does', () => {
    expect(normalizeCode(' eid 10 ')).toBe('EID10');
  });

  it('says why a code does not work, in the page language', () => {
    expect(couponRefusal({ reason: 'ended' }, en, money)).toBe('This code has ended.');
    expect(couponRefusal({ reason: 'ended' }, bn, money)).toBe('এই কোডের মেয়াদ শেষ।');
    expect(couponRefusal({ reason: 'min_order', minOrderMinor: 200_000 }, en, money)).toBe(
      'This code works on orders of ৳2000 or more.',
    );
    expect(couponRefusal({ reason: 'something_new' }, en, money)).toBe('This code is not valid.');
  });

  it('reads the order’s refusal and the guessing limit', () => {
    expect(
      couponProblemText(
        { status: 422, code: 'coupon_invalid', detail: 'x', reason: 'used_up' },
        en,
        money,
      ),
    ).toBe('This code has been used up.');
    expect(couponProblemText({ status: 429, code: 'rate_limited', detail: 'x' }, bn, money)).toBe(
      bn.couponTooMany,
    );
    expect(
      couponProblemText({ status: 409, code: 'shop_closed', detail: 'Closed.' }, en, money),
    ).toBe('Closed.');
  });
});

describe('A/B test id', () => {
  it('is random, has the API format, and is checked before use', () => {
    const a = newAbId();
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(newAbId()).not.toBe(a);
    expect(validAbId(a)).toBe(a);
    expect(validAbId('short')).toBeUndefined();
    expect(validAbId('x'.repeat(65))).toBeUndefined();
    expect(validAbId('has space in it!!')).toBeUndefined();
    expect(validAbId(null)).toBeUndefined();
  });

  it('is given on landing page paths only', () => {
    expect(mayBeLandingPath('aloe-offer')).toBe(true);
    expect(mayBeLandingPath('checkout')).toBe(false);
    expect(mayBeLandingPath('cart')).toBe(false);
  });
});
