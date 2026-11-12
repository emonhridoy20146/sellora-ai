import { describe, expect, it } from 'vitest';
import {
  addDays,
  expectedCtr,
  groupBy,
  opportunities,
  productSlugOf,
  totals,
} from './search-report.js';

describe('Search Console report (ADR 0032)', () => {
  it('adds up days, weighting position by impressions', () => {
    expect(
      totals([
        { date: '2026-11-01', clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
        { date: '2026-11-02', clicks: 0, impressions: 300, ctr: 0, position: 10 },
      ]),
    ).toEqual({ clicks: 10, impressions: 400, ctr: 0.025, position: 8 });
    expect(totals([])).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: null });
  });

  it('steps dates across months', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('groups by phrase or page, most clicked first', () => {
    const rows = [
      { query: 'a', page: 'p1', clicks: 1, impressions: 10, ctr: 0.1, position: 4 },
      { query: 'a', page: 'p2', clicks: 3, impressions: 30, ctr: 0.1, position: 8 },
      { query: 'b', page: 'p1', clicks: 2, impressions: 5, ctr: 0.4, position: 1 },
    ];
    expect(groupBy(rows, 'query')).toEqual([
      { key: 'a', clicks: 4, impressions: 40, ctr: 0.1, position: 7 },
      { key: 'b', clicks: 2, impressions: 5, ctr: 0.4, position: 1 },
    ]);
    expect(groupBy(rows, 'page')[0]!.key).toBe('p2');
  });

  it('finds phrases almost on page one and pages seen but not clicked', () => {
    const row = (query: string, position: number, impressions: number, clicks: number) => ({
      query,
      page: `https://shop.test/products/${query}`,
      clicks,
      impressions,
      ctr: clicks / impressions,
      position,
    });
    const found = opportunities([
      row('page-two', 12, 40, 1),
      row('too-few', 8, 5, 0),
      row('top', 1.2, 500, 150),
      row('ignored', 2, 500, 10),
      row('deep', 35, 900, 0),
    ]);
    expect(found.map((o) => [o.kind, o.query])).toEqual([
      ['almost_page_one', 'page-two'],
      ['low_ctr', 'ignored'],
    ]);
    expect(found[1]!.expectedCtr).toBe(expectedCtr(2));
  });

  it('reads the product from a product page address', () => {
    expect(productSlugOf('https://shop.test/products/jamdani-saree')).toBe('jamdani-saree');
    expect(
      productSlugOf('https://shop.test/products/%E0%A6%B6%E0%A6%BE%E0%A6%A1%E0%A6%BC%E0%A6%BF/'),
    ).toBe('শাড়ি');
    expect(productSlugOf('https://shop.test/')).toBeNull();
    expect(productSlugOf('not a url')).toBeNull();
  });
});
