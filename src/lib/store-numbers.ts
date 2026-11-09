import type { StoreFunnelStep, StoreStats, TrafficSource } from './api/types';

export const SOURCE_LABEL: Record<TrafficSource, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  google: 'Google',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  sms: 'SMS',
  other: 'Other websites',
  direct: 'Direct or unknown',
};

export const STEP_LABEL: Record<StoreFunnelStep, string> = {
  visited: 'Visited the store',
  viewed_product: 'Looked at a product',
  added_to_cart: 'Added to cart',
  started_checkout: 'Opened the checkout',
  ordered: 'Ordered',
};

/** Each step with its share of the visitors (0 to 100, rounded), for the funnel bars. */
export function funnelRows(funnel: StoreStats['funnel']) {
  const base = funnel[0]?.shoppers ?? 0;
  return funnel.map((f) => ({
    ...f,
    label: STEP_LABEL[f.step],
    share: base > 0 ? Math.round((Math.min(f.shoppers, base) / base) * 100) : null,
  }));
}

/** "12% more than the 30 days before", or null when there is nothing to compare with. */
export function changeText(current: number, previous: number, days: number): string | null {
  if (previous === 0) return current > 0 ? `None in the ${days} days before` : null;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return `Same as the ${days} days before`;
  return `${Math.abs(pct)}% ${pct > 0 ? 'more' : 'fewer'} than the ${days} days before`;
}

/** True when the period has nothing at all to show. */
export function isEmpty(s: StoreStats): boolean {
  return s.total.visitors === 0 && s.total.orders === 0 && s.products.length === 0;
}
