import { describe, expect, it } from 'vitest';
import type { AdDestination, AdPlatformDescriptor } from './api/types';
import {
  cleanPublicId,
  destinationBadge,
  listEvents,
  publicIdError,
  weekLine,
  whatIsSent,
  whereUsed,
} from './ad-tracking';

const meta: AdPlatformDescriptor = {
  key: 'meta',
  name: 'Meta Pixel',
  publicIdLabel: 'Pixel (dataset) ID',
  publicIdHint: '',
  publicIdPattern: '^\\d{10,20}$',
  secretLabel: 'Conversions API access token',
  secretHint: null,
  testCodeLabel: 'Test event code',
  conversionLabel: false,
  serverEvents: ['ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'],
  chatOrders: true,
};
const ga4: AdPlatformDescriptor = {
  ...meta,
  key: 'ga4',
  name: 'Google Analytics 4',
  publicIdLabel: 'Measurement ID',
  publicIdPattern: '^G-[A-Z0-9]{4,20}$',
  serverEvents: ['Purchase', 'Refund'],
};
const dest = (over: Partial<AdDestination> = {}): AdDestination => ({
  id: 'd1',
  platform: 'meta',
  platformName: 'Meta Pixel',
  name: 'Main pixel',
  publicId: '123456789012345',
  conversionLabel: null,
  hasSecret: true,
  secretHint: '…0001',
  testCode: null,
  enabled: true,
  everywhere: true,
  storeIds: [],
  landingPageIds: [],
  purchaseWhen: 'placed',
  chatOrders: false,
  lastCheck: { at: '2026-11-11T10:00:00.000Z', state: 'ok', summary: 'Token works' },
  lastSentAt: null,
  lastError: null,
  createdAt: '2026-11-11T10:00:00.000Z',
  ...over,
});
const sites = {
  stores: [{ id: 's1', name: 'Nakshi Ghor' }],
  landingPages: [
    { id: 'l1', name: 'Eid offer', slug: 'eid' },
    { id: 'l2', name: 'Winter shawls', slug: 'winter' },
  ],
};

describe('ad tracking ids', () => {
  it('cleans and checks ids with the platform’s own pattern', () => {
    expect(cleanPublicId(ga4, ' g-abc 1234 ')).toBe('G-ABC1234');
    expect(cleanPublicId(meta, ' 1234 5678 9012 ')).toBe('123456789012');
    expect(publicIdError(ga4, 'g-abc1234')).toBeUndefined();
    expect(publicIdError(ga4, 'UA-1234-1')).toBe('This is not a Google Analytics 4 Measurement ID');
    expect(publicIdError(meta, '')).toBe('Enter the Pixel (dataset) ID');
  });

  it('says where an id loads', () => {
    expect(whereUsed(dest(), sites)).toBe('Your store and every landing page');
    expect(whereUsed(dest({ everywhere: false, storeIds: ['s1'] }), sites)).toBe('Nakshi Ghor');
    expect(whereUsed(dest({ everywhere: false, landingPageIds: ['l1'] }), sites)).toBe(
      'The landing page Eid offer',
    );
    expect(
      whereUsed(dest({ everywhere: false, storeIds: ['s1'], landingPageIds: ['l1', 'l2'] }), sites),
    ).toBe('Nakshi Ghor and 2 landing pages');
    expect(whereUsed(dest({ everywhere: false }), sites)).toMatch(/^Nowhere yet/);
  });

  it('says what reaches the platform', () => {
    expect(whatIsSent(meta, dest({ hasSecret: false }))).toMatch(/browser only/);
    expect(whatIsSent(meta, dest())).toBe(
      'Browser and server: product views, add to cart, checkout started and purchases.',
    );
    expect(whatIsSent(meta, dest({ purchaseWhen: 'delivered', chatOrders: true }))).toBe(
      'Browser and server: product views, add to cart, checkout started and purchases once the order is delivered, and inbox orders.',
    );
    expect(whatIsSent(ga4, dest({ hasSecret: true }))).toBe(
      'Page views, product views, cart and checkout from the shopper’s browser; purchases and refunds from the server.',
    );
    expect(whatIsSent(ga4, dest({ hasSecret: false }))).toMatch(/Purchases need the API secret/);
    expect(listEvents(['Purchase', 'Refund'])).toBe('purchases and refunds');
  });

  it('shows the state of an id and its week', () => {
    expect(destinationBadge(dest()).label).toBe('On');
    expect(destinationBadge(dest({ enabled: false })).label).toBe('Off');
    expect(
      destinationBadge(dest({ lastError: { at: '2026-11-11T10:00:00.000Z', message: 'x' } })).tone,
    ).toBe('danger');
    expect(weekLine(undefined)).toBe('No server events in the last 7 days');
    expect(weekLine({ sent: 12, failed: 1 })).toBe('12 sent, 1 failed in the last 7 days');
  });
});
