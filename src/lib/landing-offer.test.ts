import { describe, expect, it } from 'vitest';
import {
  countdownParts,
  headlinePrice,
  isLandingSlug,
  offerTotals,
  packageCharge,
  readAttribution,
  stockText,
  variantFor,
  videoSrc,
} from './landing-offer';
import type { LandingView } from './types';

const variant = (id: string, priceMinor: number, values: string[], extra = {}) => ({
  id,
  title: values.join(' / ') || 'Default',
  optionValues: values,
  priceMinor,
  compareAtPriceMinor: null,
  available: true,
  maxQuantity: null,
  ...extra,
});

// The API's e2e fixture: aloe gel at 450 taka, two-piece package for 800, a soap add-on
// for 100 (usually 150), delivery 60 in Dhaka and 120 outside.
const view = {
  product: {
    id: 'p1',
    name: 'Aloe gel',
    description: '',
    images: [],
    options: [{ name: 'Size', values: ['100ml', '200ml'] }],
    variants: [
      variant('v1', 450_00, ['100ml'], { compareAtPriceMinor: 550_00 }),
      variant('v2', 800_00, ['200ml'], { available: false, maxQuantity: 0 }),
    ],
    currency: 'BDT',
  },
  packages: [
    { id: 'one111', label: '1 piece', quantity: 1, priceMinor: null, badge: '' },
    { id: 'two222', label: '2 pieces', quantity: 2, priceMinor: 800_00, badge: 'Popular' },
  ],
  maxFreeQuantity: 10,
  addOn: {
    label: 'Soap',
    name: 'Neem soap',
    variantTitle: '',
    image: null,
    priceMinor: 100_00,
    regularPriceMinor: 150_00,
  },
  zones: [
    { id: 'dhaka', name: 'Inside Dhaka', chargeMinor: 60_00 },
    { id: 'outside', name: 'Outside Dhaka', chargeMinor: 120_00 },
  ],
} as unknown as LandingView;

describe('landing page offer', () => {
  it('accepts the same page addresses as the API', () => {
    expect(isLandingSlug('aloe-offer')).toBe(true);
    expect(isLandingSlug('a')).toBe(false);
    expect(isLandingSlug('-aloe')).toBe(false);
    expect(isLandingSlug('aloe--gel')).toBe(false);
    expect(isLandingSlug('Aloe')).toBe(false);
    expect(isLandingSlug('favicon.ico')).toBe(false);
  });

  it('prices packages as the API does', () => {
    expect(packageCharge(450_00, 2, 800_00)).toEqual({
      regularMinor: 900_00,
      totalMinor: 800_00,
      savingMinor: 100_00,
    });
    expect(packageCharge(450_00, 3, null)).toEqual({
      regularMinor: 1350_00,
      totalMinor: 1350_00,
      savingMinor: 0,
    });
    // Dearer than the pieces: the package price still stands, with no saving.
    expect(packageCharge(450_00, 1, 500_00).totalMinor).toBe(500_00);
  });

  it('adds the package, the add-on and delivery like the order the API places', () => {
    const totals = offerTotals(view, {
      packageId: 'two222',
      variantId: 'v1',
      quantity: 1,
      addOn: true,
      zoneId: 'dhaka',
    });
    // Two pieces at 800 instead of 900, the soap at 100 instead of 150, 60 to Dhaka.
    expect(totals).toEqual({
      quantity: 2,
      regularMinor: 1050_00,
      savingMinor: 150_00,
      deliveryMinor: 60_00,
      totalMinor: 960_00,
    });
    const noArea = offerTotals(view, {
      packageId: 'one111',
      variantId: 'v1',
      quantity: 1,
      addOn: false,
      zoneId: null,
    });
    expect(noArea?.deliveryMinor).toBeNull();
    expect(noArea?.totalMinor).toBe(450_00);
    expect(
      offerTotals(view, {
        packageId: null,
        variantId: 'v1',
        quantity: 1,
        addOn: false,
        zoneId: null,
      }),
    ).toBeNull();
  });

  it('caps the free quantity when the page has no packages', () => {
    const free = { ...view, packages: [], zones: [] };
    expect(
      offerTotals(free, {
        packageId: null,
        variantId: 'v1',
        quantity: 50,
        addOn: false,
        zoneId: null,
      }),
    ).toMatchObject({ quantity: 10, totalMinor: 4500_00, deliveryMinor: 0 });
  });

  it('finds the option for the chosen values', () => {
    expect(variantFor(view.product!, ['200ml'])?.id).toBe('v2');
    expect(variantFor(view.product!, [undefined])).toBeUndefined();
  });

  it('headlines the first package against what it saves', () => {
    expect(headlinePrice(view)).toEqual({ priceMinor: 450_00, regularMinor: 550_00 });
    expect(headlinePrice({ ...view, packages: [view.packages[1]!] })).toEqual({
      priceMinor: 800_00,
      regularMinor: 900_00,
    });
    expect(headlinePrice({ ...view, product: null })).toBeNull();
  });

  it('puts the stock count into the page words in its own digits', () => {
    expect(stockText('Only {count} left', 7, 'en')).toBe('Only 7 left');
    expect(stockText('মাত্র {count}টি বাকি', 12, 'bn')).toBe('মাত্র ১২টি বাকি');
  });

  it('counts down to the end of the offer', () => {
    const now = Date.parse('2026-10-28T10:00:00Z');
    expect(countdownParts('2026-10-29T12:30:15Z', now)).toEqual({
      days: 1,
      hours: 2,
      minutes: 30,
      seconds: 15,
    });
    expect(countdownParts('2026-10-28T09:59:59Z', now)).toBeNull();
    expect(countdownParts('not a date', now)).toBeNull();
  });

  it('plays videos from the privacy-friendly YouTube host or the Facebook plugin', () => {
    expect(videoSrc({ provider: 'youtube', id: 'dQw4w9WgXcQ' })).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
    );
    expect(videoSrc({ provider: 'facebook', id: 'https://www.facebook.com/x/videos/1' })).toBe(
      'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fx%2Fvideos%2F1&show_text=false',
    );
  });

  it('keeps ad tags and the referring host, never the shop itself', () => {
    expect(
      readAttribution(
        '?utm_source=facebook&utm_campaign=eid&fbclid=abc&utm_medium=',
        'https://l.facebook.com/l.php?u=x',
        'aloe-bazar.shops.test',
      ),
    ).toEqual({
      utmSource: 'facebook',
      utmCampaign: 'eid',
      fbclid: 'abc',
      referrer: 'l.facebook.com',
    });
    expect(
      readAttribution('', 'https://aloe-bazar.shops.test/', 'aloe-bazar.shops.test:3100'),
    ).toEqual({});
    expect(readAttribution(`?gclid=${'x'.repeat(300)}`, 'not a url', 'a.test').gclid).toHaveLength(
      200,
    );
  });
});
