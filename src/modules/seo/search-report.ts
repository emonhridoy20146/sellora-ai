/**
 * What the Search Console page shows (ADR 0032), as pure functions over the synced rows:
 * totals against the period before, the phrases and pages that bring visitors, and two
 * kinds of opportunity a small shop can act on.
 */

export interface DayRow {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface QueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface Totals {
  clicks: number;
  impressions: number;
  /** Clicks per impression, 0–1. */
  ctr: number;
  /** Average position weighted by impressions; null without impressions. */
  position: number | null;
}

export function totals(days: DayRow[]): Totals {
  const clicks = days.reduce((a, d) => a + d.clicks, 0);
  const impressions = days.reduce((a, d) => a + d.impressions, 0);
  const weighted = days.reduce((a, d) => a + d.position * d.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? Math.round((weighted / impressions) * 10) / 10 : null,
  };
}

/** YYYY-MM-DD of `d` in UTC (Search Console dates are in Pacific time; a day off is fine here). */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

/**
 * Typical click-through rate at an average position on Google (rounded from public CTR
 * studies). Only used to spot pages clicked much less than pages at the same place.
 */
export function expectedCtr(position: number): number {
  if (position < 1.5) return 0.28;
  if (position < 2.5) return 0.15;
  if (position < 3.5) return 0.1;
  if (position < 4.5) return 0.07;
  if (position < 5.5) return 0.05;
  if (position < 10.5) return 0.03;
  if (position < 20.5) return 0.01;
  return 0.005;
}

export interface Grouped {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Rows summed by query or by page, most clicked first. */
export function groupBy(rows: QueryPageRow[], by: 'query' | 'page', limit = 25): Grouped[] {
  const m = new Map<string, { clicks: number; impressions: number; weighted: number }>();
  for (const r of rows) {
    const k = r[by];
    const g = m.get(k) ?? { clicks: 0, impressions: 0, weighted: 0 };
    g.clicks += r.clicks;
    g.impressions += r.impressions;
    g.weighted += r.position * r.impressions;
    m.set(k, g);
  }
  return [...m.entries()]
    .map(([key, g]) => ({
      key,
      clicks: g.clicks,
      impressions: g.impressions,
      ctr: g.impressions ? g.clicks / g.impressions : 0,
      position: g.impressions ? Math.round((g.weighted / g.impressions) * 10) / 10 : 0,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, limit);
}

export type OpportunityKind = 'almost_page_one' | 'low_ctr';

export interface Opportunity {
  kind: OpportunityKind;
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** low_ctr: what pages at that position usually get. */
  expectedCtr?: number;
}

/** Fewest impressions in 28 days for a phrase to count as an opportunity. */
export const OPPORTUNITY_MIN_IMPRESSIONS = { almostPageOne: 10, lowCtr: 50 };

/**
 * Phrases worth working on:
 * - almost_page_one: shown at average position 5 to 20 (bottom of page one, or page two),
 *   where a better title and text often move a page up;
 * - low_ctr: shown often on page one but clicked less than half as much as usual there,
 *   so the title and description do not make people click.
 */
export function opportunities(rows: QueryPageRow[], limit = 20): Opportunity[] {
  const almost = rows
    .filter(
      (r) =>
        r.position >= 5 &&
        r.position <= 20 &&
        r.impressions >= OPPORTUNITY_MIN_IMPRESSIONS.almostPageOne,
    )
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map((r): Opportunity => ({ kind: 'almost_page_one', ...r }));
  const low = rows
    .filter(
      (r) =>
        r.position < 10.5 &&
        r.impressions >= OPPORTUNITY_MIN_IMPRESSIONS.lowCtr &&
        r.ctr < expectedCtr(r.position) / 2,
    )
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map((r): Opportunity => ({ kind: 'low_ctr', ...r, expectedCtr: expectedCtr(r.position) }));
  return [...almost, ...low];
}

/** The product slug in a store page address, if it is a product page. */
export function productSlugOf(pageUrl: string): string | null {
  try {
    const m = /^\/products\/([^/?#]+)\/?$/.exec(new URL(pageUrl).pathname);
    return m ? decodeURIComponent(m[1]!).toLowerCase() : null;
  } catch {
    return null;
  }
}
