import { zonedParts, zonedTimeToUtc } from '../../common/time/zoned.js';
import type { CustomerSource } from '../commerce/schemas.js';

/**
 * The fixed rules of SMS campaigns and automations (ADR 0019). They apply to every business;
 * what a business chooses (audience, text, delays) lives in its own documents.
 */

/** Texts go out only between these local hours (9 AM up to 9 PM). */
export const SEND_WINDOW = { startHour: 9, endHour: 21 } as const;
/** Recipients one sweep hands to the SMS layer for one campaign. */
export const CAMPAIGN_BATCH = 500;
/** An order this long after a campaign text counts for the campaign. */
export const ORDER_WINDOW_MS = 7 * 24 * 3600_000;
/** Test sends per campaign. */
export const MAX_CAMPAIGN_TESTS = 5;
/** The longest campaign text a business can write (before values are filled in). */
export const MAX_CAMPAIGN_TEXT_CHARS = 480;
/** An automation text waits this long after the number's last campaign or automation text. */
export const AUTOMATION_GAP_MS = 24 * 3600_000;
/** An automation text later than this (gaps, night, SMS off) is skipped, never sent late. */
export const AUTOMATION_MAX_LATE_MS = 3 * 24 * 3600_000;
/** When a wait for SMS or wallet cash is looked at again. */
export const RETRY_LATER_MS = 30 * 60_000;

export const AFTER_DELIVERY_DAYS = [1, 2, 3, 5, 7, 10, 14, 21, 30] as const;
export const WIN_BACK_DAYS = [30, 45, 60, 90, 120, 180] as const;

export const CAMPAIGN_PLACEHOLDERS = {
  name: "The customer's name",
  shop: "Your shop's name",
  link: 'The short link to the page you chose',
} as const;
export const AFTER_DELIVERY_PLACEHOLDERS = {
  ...CAMPAIGN_PLACEHOLDERS,
  order: 'The order number',
} as const;

/** The texts automations start with (no link: the business chooses a page and adds {link}). */
export const DEFAULT_AUTOMATION_TEXTS = {
  en: {
    after_delivery:
      'Hi {name}, thank you for shopping at {shop}! We hope you like your order {order}.',
    win_back: 'Hi {name}, we miss you at {shop}! Come and see what is new.',
  },
  bn: {
    after_delivery:
      '{name}, {shop} থেকে কেনার জন্য ধন্যবাদ! আশা করি অর্ডার {order} আপনার ভালো লেগেছে।',
    win_back: '{name}, {shop} আপনাকে মিস করছে! নতুন কী এসেছে দেখে যান।',
  },
} as const;

/** Who a campaign goes to: customers chosen by what they did. Empty fields do not filter. */
export interface CampaignAudience {
  /** `any`: every customer with a phone; `ordered`: at least one order; `delivered`: one delivered. */
  ordered: 'any' | 'ordered' | 'delivered';
  minOrders?: number;
  minSpentMinor?: number;
  /** Ordered in the last N days. */
  orderedWithinDays?: number;
  /** Last order more than N days ago (and at least one order). */
  noOrderForDays?: number;
  /** Has any of these tags. */
  tags?: string[];
  sources?: CustomerSource[];
}

const DAY_MS = 24 * 3600_000;

/** The customer filter for an audience (inside the business; blocked and phoneless left out). */
export function audienceFilter(a: CampaignAudience, now: Date): Record<string, unknown> {
  const f: Record<string, unknown> = { phone: { $type: 'string' }, blocked: { $ne: true } };
  const and: Record<string, unknown>[] = [];
  if (a.ordered === 'ordered') and.push({ 'stats.orders': { $gte: 1 } });
  if (a.ordered === 'delivered') and.push({ 'stats.delivered': { $gte: 1 } });
  if (a.minOrders) and.push({ 'stats.orders': { $gte: a.minOrders } });
  if (a.minSpentMinor) and.push({ 'stats.spentMinor': { $gte: a.minSpentMinor } });
  if (a.orderedWithinDays)
    and.push({
      'stats.lastOrderAt': { $gte: new Date(now.getTime() - a.orderedWithinDays * DAY_MS) },
    });
  if (a.noOrderForDays)
    and.push({ 'stats.lastOrderAt': { $lt: new Date(now.getTime() - a.noOrderForDays * DAY_MS) } });
  if (a.tags?.length) and.push({ tags: { $in: a.tags } });
  if (a.sources?.length) and.push({ source: { $in: a.sources } });
  if (and.length) f.$and = and;
  return f;
}

/** Whether `at` is inside the sending hours in `timeZone`. */
export function inSendWindow(at: Date, timeZone: string): boolean {
  const hour = zonedParts(at, timeZone).hour;
  return hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour;
}

/** `at` itself when it is inside the sending hours, otherwise the next 9 AM in `timeZone`. */
export function nextSendTime(at: Date, timeZone: string): Date {
  if (inSendWindow(at, timeZone)) return at;
  const p = zonedParts(at, timeZone);
  const today = zonedTimeToUtc(
    { year: p.year, month: p.month, day: p.day, hour: SEND_WINDOW.startHour },
    timeZone,
  );
  if (today.getTime() > at.getTime()) return today;
  // Tomorrow: step a day on from noon (safe across daylight-saving changes).
  const noon = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 12 }, timeZone);
  const t = zonedParts(new Date(noon.getTime() + DAY_MS), timeZone);
  return zonedTimeToUtc(
    { year: t.year, month: t.month, day: t.day, hour: SEND_WINDOW.startHour },
    timeZone,
  );
}

/** The first sending time of the next day in `timeZone` (when today's SMS limit is used up). */
export function tomorrowMorning(at: Date, timeZone: string): Date {
  const p = zonedParts(at, timeZone);
  const noon = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 12 }, timeZone);
  const t = zonedParts(new Date(noon.getTime() + DAY_MS), timeZone);
  return zonedTimeToUtc(
    { year: t.year, month: t.month, day: t.day, hour: SEND_WINDOW.startHour },
    timeZone,
  );
}

/** `https://shop.example/c/Ab12Cd34` → with the tracking tags the storefront adds. */
export function trackingQuery(name: string): Record<string, string> {
  return { utm_source: 'sms', utm_medium: 'sms', utm_campaign: utmName(name) };
}

/** "Eid offer 2026!" → "eid-offer-2026". */
export function utmName(name: string): string {
  return (
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'sms'
  );
}
