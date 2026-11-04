import type {
  AbandonedCart,
  AbandonedCartLine,
  CartReminderEntry,
  CartSkip,
  CartView,
  Locale,
} from './api/types';
import { renderSms, smsLength, unknownPlaceholders } from './sms';

/**
 * Abandoned cart reminders on the dashboard (ADR 0018 in sellora-api). The API checks every
 * rule again on save; these helpers only let the editor show the same answer while typing.
 */

/** "30 minutes", "1 hour", "12 hours", "1 day", "2 days". */
export function delayLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`;
}

/** 0 → "12 AM", 9 → "9 AM", 12 → "12 PM", 22 → "10 PM". */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * The reminder as the shopper gets it: values filled in, leading punctuation left by an empty
 * {name} dropped, the first letter capitalised in English, and the stop link added.
 */
export function composeReminder(
  text: string,
  values: Record<string, string>,
  language: Locale,
  stopSuffix: string,
): string {
  let body = renderSms(text, values).replace(/^[\s,،।.:;-]+/, '');
  if (language === 'en' && body) body = body[0]!.toUpperCase() + body.slice(1);
  return `${body}${stopSuffix}`;
}

/** What is wrong with a step's text, in the words the API uses, or null. */
export function reminderProblem(
  step: { enabled: boolean; text: string },
  opts: {
    placeholders: readonly string[];
    maxChars: number;
    maxParts: number;
    composed: string;
  },
): string | null {
  const text = step.text.trim();
  if (!text) return step.enabled ? 'Write the message or turn it off' : null;
  if (text.length > opts.maxChars) return `At most ${opts.maxChars} characters`;
  const unknown = unknownPlaceholders(text, opts.placeholders);
  if (unknown.length) return `This message cannot use ${unknown.map((u) => `{${u}}`).join(', ')}`;
  if (step.enabled && !text.includes('{link}'))
    return 'Put {link} in the message, so the shopper can go back to the cart';
  const parts = smsLength(opts.composed).parts;
  if (parts > opts.maxParts)
    return `With real values and the stop link this needs about ${parts} SMS parts; the most is ${opts.maxParts}. Make it shorter.`;
  return null;
}

/** The second reminder must come later than the first when both are on. */
export function stepOrderProblem(
  steps: { enabled: boolean; delayMinutes: number }[],
): string | null {
  const [first, second] = steps;
  if (first?.enabled && second?.enabled && second.delayMinutes <= first.delayMinutes)
    return 'The second reminder must come after the first';
  return null;
}

export const CART_VIEWS: { value: CartView; label: string; empty: string }[] = [
  {
    value: 'abandoned',
    label: 'Left',
    empty: 'No cart is waiting. Carts show here 30 minutes after the shopper stops.',
  },
  { value: 'recovered', label: 'Recovered', empty: 'No cart was ordered after a reminder yet.' },
  { value: 'ordered', label: 'Ordered', empty: 'No saved cart turned into an order yet.' },
  { value: 'dismissed', label: 'Stopped', empty: 'No cart had its reminders stopped.' },
  { value: 'all', label: 'All', empty: 'No cart was saved yet.' },
];

export function isCartView(v: string | null): v is CartView {
  return CART_VIEWS.some((x) => x.value === v);
}

/** Why the last due reminder did not go out, in words staff can act on. */
export const SKIP_LABEL: Record<CartSkip, string> = {
  reminders_off: 'Reminders are off',
  not_in_plan: 'Not in your plan',
  quiet_hours: 'Waiting for quiet hours to end',
  recent_reminder: 'This number had a reminder in the last 24 hours',
  below_minimum: 'Below your minimum cart total',
  sms_off: 'SMS is off',
  opted_out: 'The shopper asked to stop these messages',
};

export type CartTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

/** The badge for a cart: what happened to it, at a glance. */
export function cartBadge(c: Pick<AbandonedCart, 'state' | 'recovered' | 'reminders'>): {
  label: string;
  tone: CartTone;
} {
  switch (c.state) {
    case 'shopping':
      return { label: 'Still shopping', tone: 'neutral' };
    case 'ordered':
      return c.recovered
        ? { label: 'Recovered', tone: 'success' }
        : { label: 'Ordered', tone: 'info' };
    case 'dismissed':
      return { label: 'Stopped', tone: 'neutral' };
    case 'open':
      return sentCount(c.reminders) > 0
        ? { label: 'Reminded', tone: 'info' }
        : { label: 'Left', tone: 'warning' };
  }
}

/** Reminders that became a message (not refused for SMS off or a stopped number). */
export function sentCount(reminders: CartReminderEntry[]): number {
  return reminders.filter((r) => r.message !== null).length;
}

/** "Red saree", "2 × Red saree", "Red saree and 2 more". */
export function cartItemsLine(items: AbandonedCartLine[]): string {
  if (!items.length) return 'Empty cart';
  const first = items[0]!;
  const head = first.quantity > 1 ? `${first.quantity} × ${first.name}` : first.name;
  return items.length > 1 ? `${head} and ${items.length - 1} more` : head;
}

/** "Reminder 1", "Reminder 2", or "Sent by hand". */
export function reminderLabel(r: Pick<CartReminderEntry, 'step' | 'manual'>): string {
  return r.manual || r.step === 0 ? 'Sent by hand' : `Reminder ${r.step}`;
}

/** Whether staff can still send one by hand (the API says no after three). */
export function canRemindNow(c: Pick<AbandonedCart, 'status' | 'manualRemindersLeft'>): boolean {
  return c.status === 'open' && c.manualRemindersLeft > 0;
}
