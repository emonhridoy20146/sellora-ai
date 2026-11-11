import { describe, expect, it } from 'vitest';
import {
  browserIds,
  gaSessionCookie,
  gtagData,
  hasTags,
  mayTrack,
  metaData,
  newEventId,
  parseCookies,
  purchaseIsFresh,
  purchaseTargets,
  readConsent,
  reportedPurchases,
  tiktokData,
} from './ad-tags';
import type { AdTags } from './types';

const tags = (over: Partial<AdTags> = {}): AdTags => ({
  consent: 'off',
  meta: [{ pixelId: '1234567890123456', purchase: true }],
  tiktok: [{ pixelCode: 'CDEMOPIXEL000000001', purchase: false }],
  ga4: [{ measurementId: 'G-DEMO123456' }],
  googleAds: [
    { conversionId: 'AW-123456789', purchaseLabel: 'AbCdEf', purchase: true },
    { conversionId: 'AW-987654321', purchaseLabel: null, purchase: true },
  ],
  ...over,
});
const items = [
  { productId: 'p1', variantId: 'v1', name: 'Cotton Panjabi', quantity: 2, priceMinor: 150_000 },
  { productId: 'p2', name: 'Topi', quantity: 1, priceMinor: 25_050 },
];

describe('when the tags may load', () => {
  it('loads at once when the business does not ask, else only after a yes', () => {
    expect(mayTrack(tags(), null)).toBe(true);
    expect(mayTrack(tags({ consent: 'ask' }), null)).toBe(false);
    expect(mayTrack(tags({ consent: 'ask' }), 'no')).toBe(false);
    expect(mayTrack(tags({ consent: 'ask' }), 'yes')).toBe(true);
    const none = tags({ meta: [], tiktok: [], ga4: [], googleAds: [] });
    expect(hasTags(none)).toBe(false);
    expect(mayTrack(none, 'yes')).toBe(false);
    expect(mayTrack(null, 'yes')).toBe(false);
    expect(readConsent('yes')).toBe('yes');
    expect(readConsent('maybe')).toBeNull();
  });
});

describe('what the browser hands the server', () => {
  const page = {
    cookie:
      '_fbp=fb.1.1700000000000.123; _fbc=fb.1.1700000000000.IwAR0abc; _ttp=ttp-0123456789abcdef; _ga=GA1.1.111.222; _ga_DEMO123456=GS2.1.s1700000123$o1; other=x%20y',
    url: 'https://shop.test/products/panjabi?fbclid=IwAR0abc',
    referrer: 'https://m.facebook.com/',
    visitorId: 'visitor-0001',
  };

  it('reads the tag cookies and GA4’s session cookie for the page’s stream', () => {
    expect(parseCookies(page.cookie).other).toBe('x y');
    expect(gaSessionCookie('G-DEMO123456')).toBe('_ga_DEMO123456');
    expect(browserIds(tags(), true, page)).toEqual({
      consent: true,
      url: page.url,
      referrer: page.referrer,
      fbp: 'fb.1.1700000000000.123',
      fbc: 'fb.1.1700000000000.IwAR0abc',
      ttp: 'ttp-0123456789abcdef',
      ga: 'GA1.1.111.222',
      gaSession: 'GS2.1.s1700000123$o1',
      visitorId: 'visitor-0001',
    });
  });

  it('sends only “no” when the shopper has not agreed', () => {
    expect(browserIds(tags({ consent: 'ask' }), false, page)).toEqual({ consent: false });
  });

  it('makes event ids the API takes', () => {
    const id = newEventId('AddToCart', () => '6f1c2e9a-1b2c-4d5e-8f90-0a1b2c3d4e5f');
    expect(id).toBe('cart.6f1c2e9a1b2c4d5e8f900a1b2c3d4e5f');
    expect(id).toMatch(/^[A-Za-z0-9_.-]{8,80}$/);
  });
});

describe('each platform’s own format', () => {
  it('Meta: contents with taka prices, the value and the count', () => {
    expect(metaData(items, 'BDT')).toEqual({
      content_type: 'product',
      content_ids: ['p1', 'p2'],
      contents: [
        { id: 'p1', quantity: 2, item_price: 1500 },
        { id: 'p2', quantity: 1, item_price: 250.5 },
      ],
      num_items: 3,
      value: 3250.5,
      currency: 'BDT',
    });
  });

  it('TikTok and GA4', () => {
    expect(tiktokData(items, 'BDT')).toMatchObject({
      value: 3250.5,
      contents: [
        { content_id: 'p1', content_name: 'Cotton Panjabi', quantity: 2, price: 1500 },
        {},
      ],
    });
    expect(gtagData(items, 'BDT')).toEqual({
      currency: 'BDT',
      value: 3250.5,
      items: [
        { item_id: 'p1', item_name: 'Cotton Panjabi', quantity: 2, price: 1500 },
        { item_id: 'p2', item_name: 'Topi', quantity: 1, price: 250.5 },
      ],
    });
  });
});

describe('the purchase from the receipt', () => {
  it('goes to the tags that count it when placed; never to GA4 from the browser', () => {
    expect(purchaseTargets(tags())).toEqual({
      meta: ['1234567890123456'],
      tiktok: [],
      googleAds: ['AW-123456789/AbCdEf'],
    });
  });

  it('only on the day of the order, and once per browser', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    expect(purchaseIsFresh('2026-11-11T11:59:00Z', now)).toBe(true);
    expect(purchaseIsFresh('2026-11-10T11:00:00Z', now)).toBe(false);
    expect(purchaseIsFresh('nonsense', now)).toBe(false);
    expect(reportedPurchases('["purchase.a","purchase.b"]')).toEqual(['purchase.a', 'purchase.b']);
    expect(reportedPurchases('{bad')).toEqual([]);
    expect(reportedPurchases(null)).toEqual([]);
  });
});
