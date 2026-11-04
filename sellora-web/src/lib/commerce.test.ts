import { describe, expect, it } from 'vitest';
import { addressLines, combinations, orderTotals, splitValues } from './commerce';

describe('commerce helpers', () => {
  it('builds every option combination in order', () => {
    expect(combinations([])).toEqual([[]]);
    expect(combinations([{ values: ['S', 'M'] }, { values: ['Red', 'Blue'] }])).toEqual([
      ['S', 'Red'],
      ['S', 'Blue'],
      ['M', 'Red'],
      ['M', 'Blue'],
    ]);
  });

  it('splits option values and drops blanks and repeats', () => {
    expect(splitValues(' S, m ,M,, L ')).toEqual(['S', 'm', 'L']);
  });

  it('adds up an order like the API does', () => {
    expect(
      orderTotals(
        [
          { unitPriceMinor: 85_000, quantity: 2 },
          { unitPriceMinor: 15_000, quantity: 1 },
        ],
        10_000,
        6_000,
      ),
    ).toEqual({
      subtotalMinor: 185_000,
      discountMinor: 10_000,
      deliveryChargeMinor: 6_000,
      totalMinor: 181_000,
      discountTooLarge: false,
    });
    expect(orderTotals([{ unitPriceMinor: 100, quantity: 1 }], 200, 0).discountTooLarge).toBe(true);
  });

  it('formats an address into lines', () => {
    expect(
      addressLines({ line1: 'House 12', area: 'Dhanmondi', city: 'Dhaka', postcode: '1209' }),
    ).toEqual(['House 12', 'Dhanmondi, Dhaka 1209']);
    expect(addressLines({ line1: 'Road 5' })).toEqual(['Road 5']);
  });
});
