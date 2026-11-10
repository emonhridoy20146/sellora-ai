import { describe, expect, it } from 'vitest';
import { dictionary } from './i18n';
import {
  advanceFor,
  firstPick,
  isReturnState,
  landingOptions,
  paymentBody,
  paymentLabel,
  payingNow,
  returnMessage,
  validPick,
} from './payments';
import type { CheckoutPayments, LandingPayments, ReceiptPayment } from './types';

const bkash = { key: 'bkash' as const, name: 'bKash', hint: 'Pay with bKash', sandbox: false };
const nagad = { key: 'nagad' as const, name: 'Nagad', hint: 'Pay with Nagad', sandbox: true };
const cart = { totalMinor: 162_000, deliveryChargeMinor: 12_000, zoneId: 'outside' };
const rule = {
  mode: 'delivery' as const,
  fixedMinor: 0,
  percent: 0,
  zoneIds: ['outside'],
  minTotalMinor: 0,
};
const t = dictionary('en');

describe('advanceFor (the same rule as the API)', () => {
  it('asks the delivery charge, a fixed amount or a percent rounded up to whole taka', () => {
    expect(advanceFor(rule, cart)).toBe(12_000);
    expect(advanceFor({ ...rule, mode: 'fixed', fixedMinor: 30_000 }, cart)).toBe(30_000);
    expect(advanceFor({ ...rule, mode: 'percent', percent: 7 }, cart)).toBe(11_400);
    expect(advanceFor({ ...rule, mode: 'fixed', fixedMinor: 900_000 }, cart)).toBe(162_000);
  });
  it('asks nothing outside the chosen areas, under the minimum, or with no rule', () => {
    expect(advanceFor(rule, { ...cart, zoneId: 'dhaka' })).toBe(0);
    expect(advanceFor(rule, { ...cart, zoneId: null })).toBe(0);
    expect(advanceFor({ ...rule, minTotalMinor: 200_000 }, cart)).toBe(0);
    expect(advanceFor(null, cart)).toBe(0);
  });
});

describe('landingOptions', () => {
  const rules: LandingPayments = { cod: true, fullOnline: true, gateways: [bkash], advance: rule };
  it('prices the advance for the form as filled in', () => {
    expect(landingOptions(rules, cart)).toEqual({
      cod: true,
      fullOnline: true,
      gateways: [bkash],
      advanceMinor: 12_000,
    });
    expect(landingOptions(rules, { ...cart, zoneId: 'dhaka' }).advanceMinor).toBe(0);
  });
  it('is cash on delivery only without a gateway', () => {
    expect(landingOptions({ ...rules, gateways: [] }, cart)).toEqual({
      cod: true,
      fullOnline: false,
      gateways: [],
      advanceMinor: 0,
    });
    expect(landingOptions(undefined, cart).gateways).toEqual([]);
  });
});

describe('the shopper’s pick', () => {
  const o: CheckoutPayments = {
    cod: true,
    fullOnline: true,
    gateways: [bkash, nagad],
    advanceMinor: 0,
  };
  it('starts with cash on delivery and the first gateway; online only when COD is off', () => {
    expect(firstPick(o)).toEqual({ method: 'cod', gateway: 'bkash' });
    expect(firstPick({ ...o, cod: false })).toEqual({ method: 'online', gateway: 'bkash' });
    expect(firstPick(undefined)).toEqual({ method: 'cod', gateway: null });
  });
  it('stays valid when the shop changes its options', () => {
    expect(validPick({ method: 'online', gateway: 'nagad' }, o)).toEqual({
      method: 'online',
      gateway: 'nagad',
    });
    expect(validPick({ method: 'online', gateway: 'nagad' }, { ...o, fullOnline: false })).toEqual({
      method: 'cod',
      gateway: 'nagad',
    });
    expect(validPick({ method: 'cod', gateway: 'shurjopay' }, o).gateway).toBe('bkash');
    expect(validPick({ method: 'online', gateway: 'bkash' }, { ...o, gateways: [] })).toEqual({
      method: 'cod',
      gateway: null,
    });
  });
  it('says what is paid now and sends the gateway along whenever there is one', () => {
    expect(payingNow({ method: 'online', gateway: 'bkash' }, o, 162_000)).toBe(162_000);
    expect(
      payingNow({ method: 'cod', gateway: 'bkash' }, { ...o, advanceMinor: 12_000 }, 162_000),
    ).toBe(12_000);
    expect(payingNow({ method: 'cod', gateway: 'bkash' }, o, 162_000)).toBe(0);
    expect(paymentBody({ method: 'cod', gateway: 'bkash' }, o)).toEqual({
      method: 'cod',
      gateway: 'bkash',
    });
    expect(paymentBody({ method: 'cod', gateway: null }, { ...o, gateways: [] })).toBeUndefined();
  });
});

describe('the receipt', () => {
  const payment = (p: Partial<ReceiptPayment>): ReceiptPayment => ({
    method: 'bkash',
    status: 'unpaid',
    paidMinor: 0,
    dueMinor: 162_000,
    online: {
      gateway: 'bkash',
      gatewayName: 'bKash',
      purpose: 'full',
      dueMinor: 162_000,
      status: 'awaiting',
      sandbox: false,
    },
    payNow: { amountMinor: 162_000, gateways: [bkash] },
    ...p,
  });
  it('names how the order is paid', () => {
    expect(paymentLabel({ paymentMethod: 'cod' }, t)).toBe('Cash on delivery');
    expect(paymentLabel({ paymentMethod: 'bkash', payment: payment({}) }, t)).toBe(
      'Online payment · bKash',
    );
    expect(
      paymentLabel(
        {
          paymentMethod: 'cod',
          payment: payment({
            online: { ...payment({}).online!, purpose: 'advance', status: 'paid' },
          }),
        },
        t,
      ),
    ).toBe('Cash on delivery · Advance paid with bKash');
  });
  it('believes the order over the address bar', () => {
    const paid = payment({ online: { ...payment({}).online!, status: 'paid' }, payNow: null });
    expect(returnMessage('failed', paid, t)?.tone).toBe('good');
    expect(returnMessage('paid', payment({}), t)).toEqual({ tone: 'wait', text: t.paymentPending });
    expect(returnMessage('cancelled', payment({}), t)?.text).toBe(t.paymentCancelled);
    expect(returnMessage('unstarted', payment({}), t)?.text).toBe(t.paymentUnstarted);
    expect(returnMessage(null, payment({}), t)).toBeNull();
    expect(returnMessage('failed', payment({ online: null }), t)).toBeNull();
  });
  it('takes only the states the API sends back', () => {
    expect(['paid', 'pending', 'failed', 'cancelled', 'unstarted'].every(isReturnState)).toBe(true);
    expect(isReturnState('succeeded')).toBe(false);
    expect(isReturnState(['paid'])).toBe(false);
  });
});
