import { describe, expect, it } from 'vitest';
import {
  SEND_WINDOW,
  audienceFilter,
  inSendWindow,
  nextSendTime,
  tomorrowMorning,
  trackingQuery,
  utmName,
} from './campaign-rules.js';
import { composeMarketing, textLanguage, textProblems } from './compose.js';
import { LINK_CODE_RE } from './links.service.js';
import type { LinkChoice } from './schemas.js';

const DHAKA = 'Asia/Dhaka';
/** 2026-11-04 at `hour`:`min` in Dhaka (UTC+6, no daylight saving). */
const dhaka = (hour: number, min = 0, day = 4) => new Date(Date.UTC(2026, 10, day, hour - 6, min));

describe('campaign rules', () => {
  it('sends between 9 AM and 9 PM local time only', () => {
    expect(SEND_WINDOW).toEqual({ startHour: 9, endHour: 21 });
    expect(inSendWindow(dhaka(8, 59), DHAKA)).toBe(false);
    expect(inSendWindow(dhaka(9), DHAKA)).toBe(true);
    expect(inSendWindow(dhaka(20, 59), DHAKA)).toBe(true);
    expect(inSendWindow(dhaka(21), DHAKA)).toBe(false);
    // The same moment is night in London and day in Dhaka.
    expect(inSendWindow(new Date(Date.UTC(2026, 10, 4, 5)), 'Europe/London')).toBe(false);
    expect(inSendWindow(new Date(Date.UTC(2026, 10, 4, 5)), DHAKA)).toBe(true);
  });

  it('waits for the next 9 AM: the same morning before 9, the next one after 9 PM', () => {
    const inside = dhaka(14);
    expect(nextSendTime(inside, DHAKA)).toBe(inside);
    expect(nextSendTime(dhaka(3), DHAKA)).toEqual(dhaka(9));
    expect(nextSendTime(dhaka(22, 30), DHAKA)).toEqual(dhaka(9, 0, 5));
    expect(tomorrowMorning(dhaka(14), DHAKA)).toEqual(dhaka(9, 0, 5));
    expect(tomorrowMorning(dhaka(0, 30), DHAKA)).toEqual(dhaka(9, 0, 5));
  });

  it('keeps 9 AM across a daylight-saving change', () => {
    // London leaves summer time on 2026-10-25 at 02:00 local.
    const saturdayNight = new Date(Date.UTC(2026, 9, 24, 21, 30)); // 22:30 BST
    expect(nextSendTime(saturdayNight, 'Europe/London')).toEqual(
      new Date(Date.UTC(2026, 9, 25, 9)), // 09:00 GMT
    );
  });

  it('builds the customer filter from what the business picked', () => {
    const now = new Date(Date.UTC(2026, 10, 4));
    const day = 24 * 3600_000;
    expect(audienceFilter({ ordered: 'any' }, now)).toEqual({
      phone: { $type: 'string' },
      blocked: { $ne: true },
    });
    expect(
      audienceFilter(
        {
          ordered: 'delivered',
          minOrders: 2,
          minSpentMinor: 500_00,
          orderedWithinDays: 90,
          noOrderForDays: 30,
          tags: ['vip'],
          sources: ['messenger'],
        },
        now,
      ),
    ).toEqual({
      phone: { $type: 'string' },
      blocked: { $ne: true },
      $and: [
        { 'stats.delivered': { $gte: 1 } },
        { 'stats.orders': { $gte: 2 } },
        { 'stats.spentMinor': { $gte: 500_00 } },
        { 'stats.lastOrderAt': { $gte: new Date(now.getTime() - 90 * day) } },
        { 'stats.lastOrderAt': { $lt: new Date(now.getTime() - 30 * day) } },
        { tags: { $in: ['vip'] } },
        { source: { $in: ['messenger'] } },
      ],
    });
  });

  it('names the tracking tag after the campaign', () => {
    expect(utmName('Eid offer 2026!')).toBe('eid-offer-2026');
    expect(utmName('ঈদ অফার')).toBe('sms');
    expect(utmName('  Winter -- Sale  ')).toBe('winter-sale');
    expect(trackingQuery('Eid offer')).toEqual({
      utm_source: 'sms',
      utm_medium: 'sms',
      utm_campaign: 'eid-offer',
    });
  });

  it('accepts only 8-letter short codes', () => {
    expect(LINK_CODE_RE.test('Ab12Cd34')).toBe(true);
    expect(LINK_CODE_RE.test('Ab12Cd3')).toBe(false);
    expect(LINK_CODE_RE.test('Ab12Cd34/')).toBe(false);
  });
});

describe('composing marketing texts', () => {
  const STOP = 'https://app.sellora.test/u/Zz99Yy88';
  const link: LinkChoice = { kind: 'store', path: '/', label: 'Nakshi Ghor' };
  const none: LinkChoice = { kind: 'none' };
  const opts = (l: LinkChoice, composed: string) => ({
    path: 'text',
    placeholders: ['name', 'shop', 'link'],
    link: l,
    maxChars: 480,
    composed,
    required: true,
  });

  it('tells Bangla texts from English ones', () => {
    expect(textLanguage('Eid sale at {shop}')).toBe('en');
    expect(textLanguage('{shop}-এ ঈদ অফার')).toBe('bn');
  });

  it('fills in values, tidies an empty name and adds the stop link', () => {
    expect(
      composeMarketing(
        '{name}, new at {shop}: {link}',
        { name: '', shop: 'Nakshi Ghor', link: 'x.test/c/1' },
        'en',
        STOP,
      ),
    ).toBe(`New at Nakshi Ghor: x.test/c/1 Stop: ${STOP}`);
    expect(composeMarketing('{name}, ঈদ অফার!', { name: 'রহিম' }, 'bn', STOP)).toBe(
      `রহিম, ঈদ অফার! বন্ধ করতে: ${STOP}`,
    );
  });

  it('asks for {link} when a page is chosen, and for a page when {link} is used', () => {
    expect(textProblems('Eid sale at {shop}', opts(link, 'x'))[0]!.message).toContain(
      'Put {link} in the message',
    );
    expect(textProblems('Eid sale: {link}', opts(none, 'x'))[0]!.message).toContain(
      'Choose where {link} goes',
    );
    expect(textProblems('Eid sale: {link}', opts(link, 'x'))).toEqual([]);
  });

  it('refuses unknown placeholders, empty texts when required, and texts over 6 parts', () => {
    expect(textProblems('Use {coupon}', opts(none, 'x'))[0]!.message).toContain('{coupon}');
    expect(textProblems('  ', opts(none, ''))[0]!.message).toBe('Write the message');
    expect(textProblems('  ', { ...opts(none, ''), required: false })).toEqual([]);
    const long = 'আ'.repeat(410);
    expect(textProblems('Hi', opts(none, long))[0]!.message).toContain('7 SMS parts');
  });
});
