import { plainSmsText } from './segments.js';

/** What an SMS is for. Order messages are service messages; the rest are marketing. */
export const ORDER_SMS_EVENTS = [
  'order_placed',
  'order_confirmed',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
] as const;
export type OrderSmsEvent = (typeof ORDER_SMS_EVENTS)[number];

export const SMS_PURPOSES = [...ORDER_SMS_EVENTS, 'test', 'cart_recovery', 'campaign'] as const;
export type SmsPurpose = (typeof SMS_PURPOSES)[number];

/** Marketing purposes need the number not to have opted out, and carry an opt-out link. */
export const MARKETING_PURPOSES: ReadonlySet<SmsPurpose> = new Set(['cart_recovery', 'campaign']);

export type SmsLanguage = 'en' | 'bn';

/** The placeholders each kind of message can use, and what they stand for. */
export const ORDER_PLACEHOLDERS = {
  name: "The customer's name",
  order: 'The order number',
  total: 'The order total',
  shop: "Your shop's name",
  phone: "Your shop's phone number",
} as const;
export const SHIPPING_PLACEHOLDERS = {
  ...ORDER_PLACEHOLDERS,
  courier: 'The courier',
  tracking: "The courier's tracking link",
} as const;

export function placeholdersFor(event: OrderSmsEvent): readonly string[] {
  return Object.keys(event === 'order_shipped' ? SHIPPING_PLACEHOLDERS : ORDER_PLACEHOLDERS);
}

export interface OrderTemplate {
  enabled: boolean;
  text: string;
}

/** The texts a business starts with. Short, so English stays in one part where it can. */
export const DEFAULT_ORDER_TEMPLATES: Record<SmsLanguage, Record<OrderSmsEvent, string>> = {
  en: {
    order_placed:
      'Hi {name}, we got your order {order} ({total}). We will call you to confirm. {shop}',
    order_confirmed: 'Your order {order} is confirmed. Total {total}, pay on delivery. {shop}',
    order_shipped: 'Your order {order} is on its way with {courier}. Track it: {tracking} {shop}',
    order_delivered: 'Your order {order} was delivered. Thank you for shopping with {shop}!',
    order_cancelled: 'Your order {order} was cancelled. Questions? Call {phone}. {shop}',
  },
  bn: {
    order_placed:
      '{name}, আপনার অর্ডার {order} ({total}) পেয়েছি। কনফার্ম করতে আমরা কল করব। {shop}',
    order_confirmed:
      'আপনার অর্ডার {order} কনফার্ম হয়েছে। মোট {total}, পণ্য পেয়ে টাকা দিন। {shop}',
    order_shipped:
      'আপনার অর্ডার {order} {courier} দিয়ে পাঠানো হয়েছে। ট্র্যাক করুন: {tracking} {shop}',
    order_delivered: 'আপনার অর্ডার {order} পৌঁছে গেছে। {shop} থেকে কেনার জন্য ধন্যবাদ!',
    order_cancelled: 'আপনার অর্ডার {order} বাতিল হয়েছে। প্রশ্ন থাকলে কল করুন {phone}। {shop}',
  },
};

export function defaultOrderTemplates(language: SmsLanguage): Record<OrderSmsEvent, OrderTemplate> {
  const texts = DEFAULT_ORDER_TEMPLATES[language];
  return Object.fromEntries(
    ORDER_SMS_EVENTS.map((e) => [e, { enabled: false, text: texts[e] }]),
  ) as Record<OrderSmsEvent, OrderTemplate>;
}

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

/** The placeholders a text uses that the message cannot fill. */
export function unknownPlaceholders(text: string, allowed: readonly string[]): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) if (!allowed.includes(m[1]!)) out.add(m[1]!);
  return [...out];
}

/**
 * Fills a template. Missing values leave nothing behind, and the spaces around them are
 * tidied, so "Track it: {tracking} {shop}" without a link reads "Track it: Nakshi Ghor".
 */
export function renderSms(text: string, values: Record<string, string | undefined>): string {
  const filled = text.replace(PLACEHOLDER_RE, (whole, key: string) =>
    key in values ? (values[key] ?? '').trim() : whole,
  );
  return plainSmsText(filled)
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?।])/g, '$1')
    .trim();
}

/** Money for an SMS: "Tk 1,250" in English (stays GSM), "৳১,২৫০" in Bangla. */
export function smsMoney(minor: number, currency: string, language: SmsLanguage): string {
  const major = minor / 100;
  const digits = Number.isInteger(major) ? 0 : 2;
  if (language === 'bn')
    return new Intl.NumberFormat('bn-BD', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
      .format(major)
      .replace(/\s/g, '');
  const amount = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(major);
  return `${currency === 'BDT' ? 'Tk' : currency} ${amount}`;
}
