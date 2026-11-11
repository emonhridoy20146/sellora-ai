import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/app-config.js';
import type { AdEvent } from './ad-tracking.types.js';
import {
  e164,
  fbcFromClickId,
  gaClientId,
  gaClientIdFrom,
  gaSessionId,
  major,
  metaPhone,
  normEmail,
  normWord,
  splitName,
  validFbId,
  validTtp,
} from './hash.js';
import { Ga4AdPlatform } from './platforms/ga4.platform.js';
import { MetaAdPlatform } from './platforms/meta.platform.js';
import { TikTokAdPlatform } from './platforms/tiktok.platform.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const config = { get: () => 'https://example.test' } as unknown as AppConfig;
const noFetch = (() => Promise.reject(new Error('no network'))) as typeof fetch;

const event = (over: Partial<AdEvent> = {}): AdEvent => ({
  name: 'Purchase',
  eventId: 'purchase.64b000000000000000000001',
  time: 1_700_000_000,
  actionSource: 'website',
  url: 'https://shop.test/checkout',
  currency: 'BDT',
  valueMinor: 162_000,
  items: [{ id: 'p1', name: 'Cotton Panjabi', quantity: 1, priceMinor: 150_000 }],
  orderNumber: 'KC-1001',
  user: {
    email: '  Rahima@Example.COM ',
    phone: '+8801712345678',
    firstName: 'Rahima',
    lastName: 'Akter',
    city: 'Cox’s Bazar',
    country: 'bd',
    externalId: 'customer:abc',
    ip: '203.0.113.9',
    userAgent: 'UA',
    fbp: 'fb.1.1700000000000.123',
  },
  consent: true,
  ...over,
});

describe('normalizing shopper details (ADR 0030)', () => {
  it('writes phone numbers in E.164, completing local Bangladeshi numbers only', () => {
    expect(e164('01712345678')).toBe('+8801712345678');
    expect(e164('8801712345678')).toBe('+8801712345678');
    expect(e164('+880 1712-345678')).toBe('+8801712345678');
    expect(e164('+44 20 7946 0958')).toBe('+442079460958');
    expect(e164('12345')).toBeUndefined();
    expect(e164('0201234567')).toBeUndefined();
    expect(metaPhone('01712345678')).toBe('8801712345678');
  });

  it('lower-cases emails and words, keeping Bangla letters', () => {
    expect(normEmail(' A.B@Mail.COM ')).toBe('a.b@mail.com');
    expect(normEmail('not-an-email')).toBeUndefined();
    expect(normWord('Cox’s Bazar')).toBe('coxsbazar');
    expect(normWord('ঢাকা')).toBe('ঢাকা');
    expect(normWord(' - ')).toBeUndefined();
    expect(splitName('Rahim Uddin Ahmed')).toEqual({ first: 'Rahim', last: 'Uddin Ahmed' });
    expect(splitName('Rahim')).toEqual({ first: 'Rahim' });
    expect(splitName('  ')).toEqual({});
  });

  it('reads the browser ids the platforms set, and drops anything malformed', () => {
    expect(gaClientId('GA1.1.111222333.1700000000')).toBe('111222333.1700000000');
    expect(gaClientId('111.222')).toBe('111.222');
    expect(gaClientId('GA1.1.abc')).toBeUndefined();
    expect(gaSessionId('GS2.1.s1700000123$o1$g1$t1700000200$j0$l0$h0')).toBe('1700000123');
    expect(gaSessionId('GS1.1.1700000123.3.1.1700000200.0.0.0')).toBe('1700000123');
    expect(gaSessionId('nonsense')).toBeUndefined();
    expect(fbcFromClickId('IwAR0clickid12345', 1_700_000_000_000)).toBe(
      'fb.1.1700000000000.IwAR0clickid12345',
    );
    expect(fbcFromClickId('<script>', 1)).toBeUndefined();
    expect(validFbId('fb.1.1700000000000.1234567890')).toBe('fb.1.1700000000000.1234567890');
    expect(validFbId('fb.9.1.x')).toBeUndefined();
    expect(validTtp('ttp-0123456789abcdef')).toBe('ttp-0123456789abcdef');
    expect(validTtp('bad id')).toBeUndefined();
    expect(gaClientIdFrom('customer:abc')).toMatch(/^\d+\.\d+$/);
    expect(gaClientIdFrom('customer:abc')).toBe(gaClientIdFrom('customer:abc'));
    expect(major(162_050)).toBe(1620.5);
  });
});

describe('what each platform is sent', () => {
  it('Meta: hashed details, plain browser ids, value in taka', () => {
    const p = new MetaAdPlatform(config, noFetch).payload(event());
    expect(p).toMatchObject({
      event_name: 'Purchase',
      event_id: 'purchase.64b000000000000000000001',
      action_source: 'website',
      event_source_url: 'https://shop.test/checkout',
      user_data: {
        em: [sha('rahima@example.com')],
        ph: [sha('8801712345678')],
        fn: [sha('rahima')],
        ln: [sha('akter')],
        ct: [sha('coxsbazar')],
        country: [sha('bd')],
        external_id: [sha('customer:abc')],
        client_ip_address: '203.0.113.9',
        client_user_agent: 'UA',
        fbp: 'fb.1.1700000000000.123',
      },
      custom_data: { currency: 'BDT', value: 1620, order_id: 'KC-1001', num_items: 1 },
    });
    // No page address for events that did not happen on a page.
    const chat = new MetaAdPlatform(config, noFetch).payload(event({ actionSource: 'chat' }));
    expect(chat).not.toHaveProperty('event_source_url');
  });

  it('TikTok: hashed email and E.164 phone, the order id', () => {
    const p = new TikTokAdPlatform(config, noFetch).payload(event());
    expect(p).toMatchObject({
      event: 'Purchase',
      user: { email: sha('rahima@example.com'), phone: sha('+8801712345678'), ip: '203.0.113.9' },
      properties: {
        value: 1620,
        order_id: 'KC-1001',
        contents: [{ content_id: 'p1', price: 1500 }],
      },
    });
  });

  it('GA4: the purchase with its transaction id; no personal data without consent', () => {
    const ga = new Ga4AdPlatform(config, noFetch);
    const yes = ga.payload(event({ user: { ...event().user, gaClientId: '1.2' } }));
    expect(yes).toMatchObject({
      client_id: '1.2',
      timestamp_micros: 1_700_000_000_000_000,
      consent: { ad_user_data: 'GRANTED', ad_personalization: 'GRANTED' },
      user_data: { sha256_phone_number: [sha('+8801712345678')] },
      events: [{ name: 'purchase', params: { transaction_id: 'KC-1001', value: 1620 } }],
    });
    const no = ga.payload(event({ consent: false }));
    expect(no.consent).toEqual({ ad_user_data: 'DENIED', ad_personalization: 'DENIED' });
    expect(no).not.toHaveProperty('user_data');
    expect(no.client_id).toMatch(/^\d+\.\d+$/);
  });
});
