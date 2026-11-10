import { describe, expect, it } from 'vitest';
import type { OrderOnlinePayment, ShopPaymentSettings } from './api/types';
import {
  advanceFor,
  attemptReason,
  missingKeys,
  onlinePaymentBadge,
  percentInput,
} from './shop-payments';

const advance = (a: Partial<ShopPaymentSettings['advance']>): ShopPaymentSettings['advance'] => ({
  mode: 'off',
  fixedMinor: 0,
  percent: 0,
  zoneIds: [],
  minTotalMinor: 0,
  ...a,
});
const cart = { totalMinor: 162_000, deliveryChargeMinor: 12_000, zoneId: 'outside' };

describe('advanceFor (the same rule as the API)', () => {
  it('asks the delivery charge, a fixed amount or a percent rounded up to whole taka', () => {
    expect(advanceFor(advance({ mode: 'delivery' }), cart)).toBe(12_000);
    expect(advanceFor(advance({ mode: 'fixed', fixedMinor: 20_000 }), cart)).toBe(20_000);
    // 10% of 1,620.00 is 162.00; 7% is 113.40, asked as 114.
    expect(advanceFor(advance({ mode: 'percent', percent: 10 }), cart)).toBe(16_200);
    expect(advanceFor(advance({ mode: 'percent', percent: 7 }), cart)).toBe(11_400);
    expect(advanceFor(advance({ mode: 'off' }), cart)).toBe(0);
  });

  it('never asks more than the total, and only where and above what the business chose', () => {
    expect(advanceFor(advance({ mode: 'fixed', fixedMinor: 500_000 }), cart)).toBe(162_000);
    expect(advanceFor(advance({ mode: 'delivery', zoneIds: ['dhaka'] }), cart)).toBe(0);
    expect(advanceFor(advance({ mode: 'delivery', zoneIds: ['outside'] }), cart)).toBe(12_000);
    expect(
      advanceFor(advance({ mode: 'delivery', zoneIds: ['outside'] }), { ...cart, zoneId: null }),
    ).toBe(0);
    expect(advanceFor(advance({ mode: 'delivery', minTotalMinor: 200_000 }), cart)).toBe(0);
  });
});

describe('missingKeys', () => {
  const fields = [{ key: 'appKey' }, { key: 'appSecret' }];
  it('needs every key for a new account', () => {
    expect(missingKeys(fields, { appKey: 'x' }, false)).toEqual(['appSecret']);
  });
  it('keeps the saved keys when all are left empty, and needs all once one is typed', () => {
    expect(missingKeys(fields, {}, true)).toEqual([]);
    expect(missingKeys(fields, { appKey: ' ', appSecret: '' }, true)).toEqual([]);
    expect(missingKeys(fields, { appSecret: 'y' }, true)).toEqual(['appKey']);
  });
});

describe('onlinePaymentBadge', () => {
  const o = (p: Partial<OrderOnlinePayment>): OrderOnlinePayment => ({
    gateway: 'bkash',
    purpose: 'full',
    dueMinor: 100,
    status: 'awaiting',
    sandbox: false,
    paidAt: null,
    ...p,
  });
  it('names what was asked and whether it came', () => {
    expect(onlinePaymentBadge(o({ status: 'paid' }))).toEqual({
      label: 'Paid online',
      tone: 'success',
    });
    expect(onlinePaymentBadge(o({ purpose: 'advance', status: 'paid' })).label).toBe(
      'Advance paid',
    );
    expect(onlinePaymentBadge(o({ purpose: 'advance' })).label).toBe('Advance awaited');
    expect(onlinePaymentBadge(o({ status: 'failed' })).tone).toBe('danger');
  });
  it('never makes a sandbox payment look like real money', () => {
    expect(onlinePaymentBadge(o({ status: 'paid', sandbox: true }))).toEqual({
      label: 'Paid online (test)',
      tone: 'outline',
    });
  });
});

describe('percentInput', () => {
  it('takes 0 to 100 only', () => {
    expect(percentInput('25')).toBe(25);
    expect(percentInput('12.5')).toBe(12.5);
    expect(percentInput('101')).toBeNull();
    expect(percentInput('-1')).toBeNull();
    expect(percentInput('abc')).toBeNull();
    expect(percentInput('')).toBeNull();
  });
});

describe('attemptReason', () => {
  it('says in words why a try did not go through', () => {
    expect(attemptReason('shopper_cancelled')).toBe('The shopper cancelled on the payment page.');
    expect(attemptReason('nagad_aborted')).toBe('Cancelled at the gateway.');
    expect(attemptReason('shurjopay_1002')).toBe('Cancelled at the gateway.');
    expect(attemptReason('aamarpay_failed')).toBe('The gateway declined the payment.');
    expect(attemptReason('bkash_failure')).toBe('The gateway declined the payment.');
    expect(attemptReason('nagad_wrong_reference')).toMatch(/another payment/);
    expect(attemptReason('amount_mismatch')).toMatch(/different amount/);
    expect(attemptReason('expired')).toMatch(/two days/);
  });
  it('keeps the gateway’s own code or message when there are no words for it', () => {
    expect(attemptReason('shurjopay_1068')).toBe('Gateway code: shurjopay_1068');
    expect(attemptReason('Insufficient balance')).toBe('Insufficient balance');
  });
});
