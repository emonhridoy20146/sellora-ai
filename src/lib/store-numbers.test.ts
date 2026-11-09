import { describe, expect, it } from 'vitest';
import { changeText, funnelRows } from './store-numbers';

describe('store numbers', () => {
  it('shows each step as a share of the visitors, never above 100', () => {
    const rows = funnelRows([
      { step: 'visited', shoppers: 200 },
      { step: 'viewed_product', shoppers: 120 },
      { step: 'added_to_cart', shoppers: 30 },
      { step: 'started_checkout', shoppers: 20 },
      // Orders can come from shoppers whose visit was not counted (no JavaScript).
      { step: 'ordered', shoppers: 250 },
    ]);
    expect(rows.map((r) => r.share)).toEqual([100, 60, 15, 10, 100]);
    expect(rows[1]!.label).toBe('Looked at a product');
  });

  it('has no shares without visitors', () => {
    expect(funnelRows([{ step: 'visited', shoppers: 0 }])[0]!.share).toBeNull();
  });

  it('compares with the period before', () => {
    expect(changeText(120, 100, 30)).toBe('20% more than the 30 days before');
    expect(changeText(75, 100, 7)).toBe('25% fewer than the 7 days before');
    expect(changeText(10, 10, 7)).toBe('Same as the 7 days before');
    expect(changeText(5, 0, 7)).toBe('None in the 7 days before');
    expect(changeText(0, 0, 7)).toBeNull();
  });
});
