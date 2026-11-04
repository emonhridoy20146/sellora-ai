import type { SmsFailure, SmsMessageStatus, SmsPurpose } from './api/types';

/**
 * Message length the way phones and operators count it, so the editor shows the same parts
 * the API will charge for. GSM text: 160 in one part, then 153 per part; anything else
 * (Bangla, emoji): 70, then 67. GSM extension characters take two places.
 */
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENSION = new Set('^{}\\[~]|€\f');

export type SmsEncoding = 'gsm' | 'unicode';

export interface SmsLength {
  encoding: SmsEncoding;
  units: number;
  parts: number;
  /** How many more characters fit before another part starts. */
  remaining: number;
  /** Characters one part holds at this length (160/153 or 70/67). */
  perPart: number;
}

export function smsLength(text: string): SmsLength {
  let units = 0;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) units += 1;
    else if (GSM_EXTENSION.has(ch)) units += 2;
    else return measure('unicode', text.length, 70, 67);
  }
  return measure('gsm', units, 160, 153);
}

function measure(encoding: SmsEncoding, units: number, single: number, multi: number): SmsLength {
  if (units <= single)
    return {
      encoding,
      units,
      parts: units === 0 ? 0 : 1,
      remaining: single - units,
      perPart: single,
    };
  const parts = Math.ceil(units / multi);
  return { encoding, units, parts, remaining: parts * multi - units, perPart: multi };
}

/** The characters the API swaps for plain ones before sending (so English stays GSM). */
export function plainSmsText(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[   ]/g, ' ')
    .replace(/[​-‍﻿]/g, '');
}

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

/** Fills a template the way the API does, for the preview. */
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

/** Placeholders a text uses that its message cannot fill. */
export function unknownPlaceholders(text: string, allowed: readonly string[]): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) if (!allowed.includes(m[1]!)) out.add(m[1]!);
  return [...out];
}

/** "1 part · 54 characters left", in words staff can act on. */
export function lengthSummary(l: SmsLength): string {
  if (l.parts === 0) return 'Empty';
  const kind = l.encoding === 'unicode' ? 'Bangla/Unicode' : 'English';
  return `${l.parts} SMS part${l.parts === 1 ? '' : 's'} (${kind}) · ${l.remaining} characters left in this part`;
}

/** The message's cost with Sellora SMS, or null when it goes through the business's account. */
export function messageCost(parts: number, perPartMinor: number | null): number | null {
  if (perPartMinor === null || perPartMinor === 0) return null;
  return parts * perPartMinor;
}

export const ORDER_EVENT_LABEL: Record<string, { title: string; when: string }> = {
  order_placed: { title: 'Order received', when: 'When an order comes in and waits for a call' },
  order_confirmed: { title: 'Order confirmed', when: 'When you confirm an order' },
  order_shipped: {
    title: 'Order shipped',
    when: 'When the courier picks it up or you mark it shipped',
  },
  order_delivered: { title: 'Order delivered', when: 'When the courier delivers it' },
  order_cancelled: { title: 'Order cancelled', when: 'When an order is cancelled' },
};

export const PURPOSE_LABEL: Record<SmsPurpose, string> = {
  order_placed: 'Order received',
  order_confirmed: 'Order confirmed',
  order_shipped: 'Order shipped',
  order_delivered: 'Order delivered',
  order_cancelled: 'Order cancelled',
  test: 'Test',
  cart_recovery: 'Cart reminder',
  campaign: 'Campaign',
  automation: 'Automation',
};

export const STATUS_LABEL: Record<
  SmsMessageStatus,
  { label: string; tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral' }
> = {
  queued: { label: 'Waiting', tone: 'neutral' },
  sending: { label: 'Sending', tone: 'info' },
  sent: { label: 'Sent', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'warning' },
};

export const FAILURE_HELP: Record<SmsFailure, string> = {
  rejected: 'The provider refused this message.',
  auth: 'The provider did not accept the API key. Check it in Settings › SMS.',
  balance: 'Your SMS provider account is out of balance. Recharge it with the provider.',
  busy: 'The provider was busy.',
  unavailable: 'The provider could not be reached.',
  uncertain:
    'The answer was lost: the message may have been sent. It is not sent again or charged.',
  insufficient_balance: 'Your Sellora wallet did not have enough cash. Top up to keep sending.',
  daily_limit: 'The daily SMS limit was reached.',
  not_configured: 'SMS was not set up when this message was made.',
  unreachable_number: 'This provider cannot reach that number.',
};

/** A sender name the API will accept: 3–11 English letters and digits, at least one letter. */
export function senderNameProblem(name: string): string | null {
  const v = name.trim();
  if (!v) return 'Write the name';
  if (!/^[A-Za-z0-9]+$/.test(v)) return 'English letters and digits only, no spaces';
  if (v.length < 3 || v.length > 11) return '3 to 11 characters';
  if (!/[A-Za-z]/.test(v)) return 'At least one letter';
  return null;
}

/** A Bangladeshi number as people write it (01712345678); other countries stay in +form. */
export function localPhone(e164: string): string {
  return /^\+8801\d{9}$/.test(e164) ? `0${e164.slice(4)}` : e164;
}
