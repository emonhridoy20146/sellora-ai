import { describe, expect, it } from 'vitest';
import { advanceFor, checkoutOptions, type GatewayChoice } from './checkout-options.js';

const bkash: GatewayChoice = { key: 'bkash', name: 'bKash', hint: '', sandbox: false };
const base = {
  cod: true,
  fullOnline: true,
  advance: { mode: 'off' as const, fixedMinor: 0, percent: 0, zoneIds: [], minTotalMinor: 0 },
};
const cart = { totalMinor: 155_000, deliveryChargeMinor: 12_000, zoneId: 'outside' };

describe('advance on cash on delivery', () => {
  it('asks the delivery charge, a fixed amount or a percent in whole taka', () => {
    expect(advanceFor({ ...base.advance, mode: 'delivery' }, cart)).toBe(12_000);
    expect(advanceFor({ ...base.advance, mode: 'fixed', fixedMinor: 20_000 }, cart)).toBe(20_000);
    // 10% of 1,550 is 155 taka; 12.5% is 193.75, asked as 194.
    expect(advanceFor({ ...base.advance, mode: 'percent', percent: 10 }, cart)).toBe(15_500);
    expect(advanceFor({ ...base.advance, mode: 'percent', percent: 12.5 }, cart)).toBe(19_400);
  });

  it('never asks more than the total, and nothing when the rule does not apply', () => {
    expect(advanceFor({ ...base.advance, mode: 'fixed', fixedMinor: 500_000 }, cart)).toBe(155_000);
    expect(advanceFor({ ...base.advance, mode: 'delivery', zoneIds: ['dhaka'] }, cart)).toBe(0);
    expect(advanceFor({ ...base.advance, mode: 'delivery', zoneIds: ['outside'] }, cart)).toBe(
      12_000,
    );
    expect(advanceFor({ ...base.advance, mode: 'delivery', minTotalMinor: 200_000 }, cart)).toBe(0);
    expect(advanceFor({ ...base.advance, mode: 'delivery' }, { ...cart, zoneId: null })).toBe(
      12_000,
    );
    expect(
      advanceFor(
        { ...base.advance, mode: 'delivery', zoneIds: ['outside'] },
        { ...cart, zoneId: null },
      ),
    ).toBe(0);
  });
});

describe('checkout options', () => {
  it('offers only cash on delivery without a gateway, whatever the settings say', () => {
    expect(
      checkoutOptions(
        { ...base, cod: false, advance: { ...base.advance, mode: 'delivery' } },
        [],
        cart,
      ),
    ).toEqual({ cod: true, fullOnline: false, gateways: [], advanceMinor: 0 });
  });

  it('keeps cash on delivery on while full payment is off', () => {
    const o = checkoutOptions({ ...base, cod: false, fullOnline: false }, [bkash], cart);
    expect(o.cod).toBe(true);
    expect(o.fullOnline).toBe(false);
  });

  it('asks no advance when cash on delivery is off', () => {
    const o = checkoutOptions(
      { ...base, cod: false, advance: { ...base.advance, mode: 'delivery' } },
      [bkash],
      cart,
    );
    expect(o).toMatchObject({ cod: false, fullOnline: true, advanceMinor: 0 });
  });
});
