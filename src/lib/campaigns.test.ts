import { describe, expect, it } from 'vitest';
import {
  audienceProblem,
  audienceSummary,
  canSendNow,
  cleanAudience,
  composeMarketing,
  dayInZone,
  estimateLine,
  linkPreviewUrl,
  marketingTextProblem,
  scheduleProblem,
  sentOf,
  textLanguage,
  zonedToUtc,
} from './campaigns';

const WINDOW = { startHour: 9, endHour: 21 };
const STOP = ' Stop: https://app.sellora.test/u/Ab12Cd34';
const opts = (link: 'none' | 'store', composed = 'x') => ({
  placeholders: ['name', 'shop', 'link'],
  maxChars: 480,
  maxParts: 6,
  composed,
  link,
  required: true,
});

describe('campaign texts', () => {
  it('composes the text like the API, with the stop line', () => {
    expect(
      composeMarketing('{name}, Eid at {shop}', { name: '', shop: 'Nakshi' }, 'en', STOP),
    ).toBe(`Eid at Nakshi${STOP}`);
    expect(textLanguage('{shop}-এ ঈদ অফার')).toBe('bn');
    expect(textLanguage('Eid at {shop}')).toBe('en');
  });

  it('asks for {link} and a page together, in the API’s words', () => {
    expect(marketingTextProblem('Eid sale', opts('store'))).toBe(
      'Put {link} in the message, or choose no link',
    );
    expect(marketingTextProblem('Eid sale {link}', opts('none'))).toBe(
      'Choose where {link} goes, or take it out of the message',
    );
    expect(marketingTextProblem('Eid sale {link}', opts('store'))).toBeNull();
    expect(marketingTextProblem('Use {coupon}', opts('none'))).toBe(
      'This message cannot use {coupon}',
    );
    expect(marketingTextProblem(' ', opts('none'))).toBe('Write the message');
    expect(marketingTextProblem(' ', { ...opts('none'), required: false })).toBeNull();
    expect(marketingTextProblem('Hi', opts('none', 'আ'.repeat(410)))).toContain('7 SMS parts');
  });

  it('previews the short link on the right store', () => {
    const options = {
      stores: [
        { id: 's1', name: 'Main', url: 'https://main.shops.test', status: 'live' },
        { id: 's2', name: 'Second', url: 'https://second.shops.test', status: 'live' },
      ],
      landingPages: [{ id: 'p1', name: 'Eid', slug: 'eid', storeId: 's2' }],
    };
    expect(linkPreviewUrl({ kind: 'none' }, options)).toBe('');
    expect(linkPreviewUrl({ kind: 'store', storeId: 's2' }, options)).toBe(
      'https://second.shops.test/c/Ab12Cd34',
    );
    expect(linkPreviewUrl({ kind: 'landing_page', targetId: 'p1' }, options)).toBe(
      'https://second.shops.test/c/Ab12Cd34',
    );
    expect(linkPreviewUrl({ kind: 'product', targetId: 'x' }, options)).toBe(
      'https://main.shops.test/c/Ab12Cd34',
    );
    expect(linkPreviewUrl({ kind: 'store' }, options, 'https://main.shops.test/c/Real1234')).toBe(
      'https://main.shops.test/c/Real1234',
    );
  });
});

describe('audiences', () => {
  it('sends only the filters that were chosen', () => {
    expect(
      cleanAudience({ ordered: 'any', minOrders: 0, tags: [], sources: [], noOrderForDays: 30 }),
    ).toEqual({ ordered: 'any', noOrderForDays: 30 });
  });

  it('describes an audience in one line', () => {
    expect(
      audienceSummary(
        { ordered: 'ordered', minOrders: 2, tags: ['vip'], sources: ['messenger'] },
        'BDT',
      ),
    ).toBe('Customers who ordered · 2+ orders · tagged vip · from Messenger');
    expect(audienceSummary({ ordered: 'any' }, 'BDT')).toBe('Every customer with a phone number');
  });

  it('catches filters nobody can match', () => {
    expect(
      audienceProblem({ ordered: 'any', orderedWithinDays: 30, noOrderForDays: 60 }),
    ).toContain('Change one of them');
    expect(
      audienceProblem({ ordered: 'any', orderedWithinDays: 90, noOrderForDays: 30 }),
    ).toBeNull();
  });
});

describe('scheduling in the business’s time zone', () => {
  it('turns a local date and time into the moment', () => {
    expect(zonedToUtc('2026-11-05', 15, 30, 'Asia/Dhaka').toISOString()).toBe(
      '2026-11-05T09:30:00.000Z',
    );
    // London is on GMT in November and on BST in July.
    expect(zonedToUtc('2026-11-05', 9, 0, 'Europe/London').toISOString()).toBe(
      '2026-11-05T09:00:00.000Z',
    );
    expect(zonedToUtc('2026-07-05', 9, 0, 'Europe/London').toISOString()).toBe(
      '2026-07-05T08:00:00.000Z',
    );
    expect(dayInZone(new Date('2026-11-04T20:00:00Z'), 'Asia/Dhaka')).toBe('2026-11-05');
  });

  it('refuses times too soon, too far, or outside 9 AM–9 PM', () => {
    const now = new Date('2026-11-04T06:00:00Z'); // noon in Dhaka
    expect(scheduleProblem(new Date('2026-11-04T06:02:00Z'), 'Asia/Dhaka', WINDOW, now)).toContain(
      '5 minutes',
    );
    expect(scheduleProblem(new Date('2027-02-01T06:00:00Z'), 'Asia/Dhaka', WINDOW, now)).toContain(
      '60 days',
    );
    expect(scheduleProblem(new Date('2026-11-04T16:00:00Z'), 'Asia/Dhaka', WINDOW, now)).toContain(
      'between 9 AM and 9 PM',
    );
    expect(scheduleProblem(new Date('2026-11-04T09:00:00Z'), 'Asia/Dhaka', WINDOW, now)).toBeNull();
    expect(canSendNow('Asia/Dhaka', WINDOW, now)).toBe(true);
    expect(canSendNow('Asia/Dhaka', WINDOW, new Date('2026-11-04T18:00:00Z'))).toBe(false);
  });
});

describe('numbers', () => {
  it('adds up sent messages and the cost line', () => {
    expect(sentOf({ queued: 1, sending: 0, sent: 3, delivered: 2, failed: 1, unknown: 0 })).toBe(5);
    expect(estimateLine(1197, 1, 50, 'BDT')).toMatch(/^1,197 × 1 part × .*0\.50 = .*598\.50$/);
  });
});
