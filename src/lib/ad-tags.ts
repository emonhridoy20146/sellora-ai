/**
 * The business's own ad tags (Meta Pixel, TikTok Pixel, Google Analytics 4, Google Ads) on
 * its store and landing pages (ADR 0030): what each tag is told, in each platform's own
 * format, and the ids the browser hands to the server copy. Pure functions here; loading the
 * tags is in `ad-tags-browser.ts`.
 */
import type { AdTags, BrowserPurchase } from './types';

export type AdBrowserEvent = 'ViewContent' | 'AddToCart' | 'InitiateCheckout';

/** One product line as the tags see it. Prices in minor units, as everywhere else. */
export interface AdItem {
  productId: string;
  variantId?: string | undefined;
  name: string;
  quantity: number;
  priceMinor: number;
}

export const CONSENT_KEY = 'sl_consent';
export const PURCHASES_KEY = 'sl_ad_purchases';

/** Whether any tag is set for the page. */
export function hasTags(tags: AdTags | null | undefined): tags is AdTags {
  return Boolean(
    tags && (tags.meta.length || tags.tiktok.length || tags.ga4.length || tags.googleAds.length),
  );
}

/** The shopper's choice, as kept: 'yes', 'no', or none yet. */
export function readConsent(raw: string | null): 'yes' | 'no' | null {
  return raw === 'yes' || raw === 'no' ? raw : null;
}

/** Whether tags may load: always when the business does not ask, else only after a yes. */
export function mayTrack(tags: AdTags | null | undefined, choice: 'yes' | 'no' | null): boolean {
  if (!hasTags(tags)) return false;
  return tags.consent === 'off' || choice === 'yes';
}

export const major = (minor: number) => Math.round(minor) / 100;

/** A fresh event id the server copy shares, so each platform counts the event once. */
export function newEventId(kind: AdBrowserEvent, random: () => string): string {
  const short = { ViewContent: 'view', AddToCart: 'cart', InitiateCheckout: 'checkout' }[kind];
  return `${short}.${random()
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 32)}`;
}

/** The cookies a browser has, by name. */
export function parseCookies(cookie: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** GA4 keeps the session in `_ga_<id without G->`. */
export const gaSessionCookie = (measurementId: string) => `_ga_${measurementId.replace(/^G-/, '')}`;

/** What the browser tells the server along with an event or an order. */
export interface AdBrowserIds {
  consent: boolean;
  url?: string;
  referrer?: string;
  fbp?: string;
  fbc?: string;
  ttp?: string;
  ga?: string;
  gaSession?: string;
  visitorId?: string;
}

/**
 * The tag cookies and page, only once the shopper may be tracked. Without agreement only
 * `consent: false` goes, and the server sends nothing about them.
 */
export function browserIds(
  tags: AdTags | null | undefined,
  allowed: boolean,
  page: { cookie: string; url: string; referrer: string; visitorId?: string | undefined },
): AdBrowserIds {
  if (!allowed) return { consent: false };
  const c = parseCookies(page.cookie);
  const ga4 = tags?.ga4[0]?.measurementId;
  const out: AdBrowserIds = { consent: true, url: page.url.slice(0, 1000) };
  const set = (k: keyof Omit<AdBrowserIds, 'consent'>, v: string | undefined) => {
    if (v) out[k] = v.slice(0, 600);
  };
  set('referrer', page.referrer);
  set('fbp', c._fbp);
  set('fbc', c._fbc);
  set('ttp', c._ttp);
  set('ga', c._ga);
  if (ga4) set('gaSession', c[gaSessionCookie(ga4)]);
  set('visitorId', page.visitorId);
  return out;
}

const value = (items: AdItem[]) => major(items.reduce((n, i) => n + i.priceMinor * i.quantity, 0));

/** Meta's custom data for product, cart and checkout events. */
export function metaData(items: AdItem[], currency: string) {
  return {
    content_type: 'product',
    content_ids: items.map((i) => i.productId),
    contents: items.map((i) => ({
      id: i.productId,
      quantity: i.quantity,
      item_price: major(i.priceMinor),
    })),
    num_items: items.reduce((n, i) => n + i.quantity, 0),
    value: value(items),
    currency,
  };
}

/** TikTok's properties for the same events. */
export function tiktokData(items: AdItem[], currency: string) {
  return {
    content_type: 'product',
    contents: items.map((i) => ({
      content_id: i.productId,
      content_type: 'product',
      content_name: i.name,
      quantity: i.quantity,
      price: major(i.priceMinor),
    })),
    value: value(items),
    currency,
  };
}

/** GA4's ecommerce parameters. */
export function gtagData(items: AdItem[], currency: string) {
  return {
    currency,
    value: value(items),
    items: items.map((i) => ({
      item_id: i.productId,
      item_name: i.name,
      quantity: i.quantity,
      price: major(i.priceMinor),
    })),
  };
}

export const GTAG_EVENT: Record<AdBrowserEvent, string> = {
  ViewContent: 'view_item',
  AddToCart: 'add_to_cart',
  InitiateCheckout: 'begin_checkout',
};

/** The purchase's lines as tags take them. */
export function purchaseItems(p: BrowserPurchase): AdItem[] {
  return p.items.map((i) => ({
    productId: i.id,
    name: i.name,
    quantity: i.quantity,
    priceMinor: i.priceMinor,
  }));
}

/** Purchases are reported from the receipt only on the day the order was placed. */
export function purchaseIsFresh(placedAt: string, now = Date.now()): boolean {
  const at = Date.parse(placedAt);
  return Number.isFinite(at) && now - at < 24 * 3600 * 1000 && now - at > -5 * 60 * 1000;
}

/** The purchases this browser already reported, newest last (kept short). */
export function reportedPurchases(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-50) : [];
  } catch {
    return [];
  }
}

/** Which tags report a purchase from the browser: those that count it when placed. */
export function purchaseTargets(tags: AdTags) {
  return {
    meta: tags.meta.filter((m) => m.purchase).map((m) => m.pixelId),
    tiktok: tags.tiktok.filter((t) => t.purchase).map((t) => t.pixelCode),
    // GA4 purchases come from the server only, so Analytics never counts one twice.
    googleAds: tags.googleAds
      .filter((g) => g.purchase && g.purchaseLabel)
      .map((g) => `${g.conversionId}/${g.purchaseLabel}`),
  };
}
