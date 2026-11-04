import { zonedParts, zonedTimeToUtc } from '../../common/time/zoned.js';
import type { SmsLanguage } from '../sms/templates.js';

/** Delays a reminder step can use, in minutes (30 minutes to 2 days). */
export const CART_DELAYS = [30, 60, 120, 180, 360, 720, 1440, 2880] as const;
export type CartDelay = (typeof CART_DELAYS)[number];

/** Reminder steps a business can turn on. */
export const CART_STEPS = 2;

/** A cart idle this long counts as left (shown as abandoned; earlier it is "still shopping"). */
export const ABANDONED_AFTER_MS = 30 * 60_000;
/** A step whose time passed by more than this is skipped, never sent late. */
export const STEP_GRACE_MS = 12 * 3600_000;
/** At most one cart reminder to a number in this window (across the business's carts). */
export const SAME_PHONE_GAP_MS = 24 * 3600_000;
/** While SMS is off, a due reminder is looked at again this often (until its time runs out). */
export const SMS_OFF_RETRY_MS = 30 * 60_000;
/** An order within this long after a reminder counts the cart as recovered. */
export const RECOVERY_WINDOW_MS = 7 * 24 * 3600_000;
/** Carts are forgotten this long after their last change. */
export const CART_TTL_MS = 60 * 24 * 3600_000;
/** Reminders staff may send by hand, per cart. */
export const MAX_MANUAL_REMINDERS = 3;
/** The longest reminder text a business can write (before values are filled in). */
export const MAX_CART_TEXT_CHARS = 480;

export const CART_PLACEHOLDERS = {
  name: "The shopper's name (left out when they did not type one)",
  shop: "Your shop's name",
  items: 'What is in the cart, shortly ("Red saree and 2 more")',
  total: 'The cart total',
  link: 'The link back to the cart (required)',
} as const;
export const CART_PLACEHOLDER_KEYS = Object.keys(CART_PLACEHOLDERS);

/**
 * The texts a business starts with. With the two links they fill most of one English part
 * (160 characters); Bangla needs Unicode, so it takes two or three parts whatever the words.
 */
export const DEFAULT_CART_TEXTS: Record<SmsLanguage, [string, string]> = {
  en: [
    'Hi {name}, you left {items} at {shop}. Order here: {link}',
    '{name}, your {shop} cart ({total}) is still saved: {link}',
  ],
  bn: [
    '{name}, {shop}-এ আপনার কার্টে {items} রয়ে গেছে। অর্ডার: {link}',
    '{name}, {shop}-এ আপনার কার্ট ({total}) রাখা আছে: {link}',
  ],
};

export interface CartStep {
  enabled: boolean;
  delayMinutes: number;
  text: string;
}

export function defaultCartSteps(language: SmsLanguage): CartStep[] {
  const [first, second] = DEFAULT_CART_TEXTS[language];
  return [
    { enabled: true, delayMinutes: 60, text: first },
    { enabled: false, delayMinutes: 1440, text: second },
  ];
}

/** What Sellora adds to every reminder, so the shopper can always stop them. */
export function optOutSuffix(language: SmsLanguage, url: string): string {
  return language === 'bn' ? ` বন্ধ করতে: ${url}` : ` Stop: ${url}`;
}

/** The steps that are on, in order, with their number (1 or 2). */
export function enabledSteps(steps: CartStep[]): (CartStep & { step: number })[] {
  return steps.map((s, i) => ({ ...s, step: i + 1 })).filter((s) => s.enabled);
}

/** "Red saree", "2 × Red saree", "Red saree and 2 more" (and the Bangla forms). */
export function itemsSummary(
  lines: { name: string; quantity: number }[],
  language: SmsLanguage,
): string {
  if (!lines.length) return '';
  const first = lines[0]!;
  const name = first.name.length > 32 ? `${first.name.slice(0, 31).trimEnd()}…` : first.name;
  const more = lines.length - 1;
  if (language === 'bn') {
    const n = (x: number) => x.toLocaleString('bn-BD');
    const head = first.quantity > 1 ? `${n(first.quantity)} × ${name}` : name;
    return more > 0 ? `${head} ও আরও ${n(more)}টি পণ্য` : head;
  }
  const head = first.quantity > 1 ? `${first.quantity} × ${name}` : name;
  return more > 0 ? `${head} and ${more} more` : head;
}

export interface QuietHours {
  enabled: boolean;
  /** Local hour quiet hours start (0–23). */
  startHour: number;
  /** Local hour they end (0–23); earlier than the start means they run past midnight. */
  endHour: number;
}

/** Whether `at` falls in quiet hours in `timeZone`. */
export function inQuietHours(at: Date, q: QuietHours, timeZone: string): boolean {
  if (!q.enabled || q.startHour === q.endHour) return false;
  const hour = zonedParts(at, timeZone).hour;
  return q.startHour < q.endHour
    ? hour >= q.startHour && hour < q.endHour
    : hour >= q.startHour || hour < q.endHour;
}

/** The first moment after `at` when quiet hours are over (`endHour`:00 local time). */
export function quietHoursEnd(at: Date, q: QuietHours, timeZone: string): Date {
  const p = zonedParts(at, timeZone);
  const today = zonedTimeToUtc(
    { year: p.year, month: p.month, day: p.day, hour: q.endHour, minute: 0 },
    timeZone,
  );
  if (today.getTime() > at.getTime()) return today;
  // The end is tomorrow: step a day on from noon (safe across daylight-saving changes).
  const noonTomorrow = new Date(
    zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 12 }, timeZone).getTime() +
      24 * 3600_000,
  );
  const t = zonedParts(noonTomorrow, timeZone);
  return zonedTimeToUtc(
    { year: t.year, month: t.month, day: t.day, hour: q.endHour, minute: 0 },
    timeZone,
  );
}

/**
 * When a cart's next automatic reminder is due. `nextStep` is the index into the enabled
 * steps (0 for the first). Steps whose time passed by more than STEP_GRACE_MS are skipped.
 * Returns null when no step is left.
 */
export function nextDue(
  lastActivityAt: Date,
  steps: (CartStep & { step: number })[],
  nextStep: number,
  now: Date,
): { index: number; at: Date } | null {
  for (let i = nextStep; i < steps.length; i += 1) {
    const at = new Date(lastActivityAt.getTime() + steps[i]!.delayMinutes * 60_000);
    if (now.getTime() - at.getTime() <= STEP_GRACE_MS) return { index: i, at };
  }
  return null;
}
