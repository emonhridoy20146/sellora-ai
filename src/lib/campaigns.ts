import type {
  AutomationSkip,
  CampaignAudience,
  CampaignOptions,
  CampaignPause,
  CampaignRecipient,
  CampaignStatus,
  CampaignWait,
  LinkInput,
  LinkKind,
  Locale,
  SmsMessageStatus,
} from './api/types';
import { composeReminder, hourLabel } from './carts';
import { formatDateTime, formatMoney, formatNumber } from './format';
import { smsLength, unknownPlaceholders } from './sms';

/**
 * SMS campaigns and automations on the dashboard (ADR 0019 in sellora-api). The API checks
 * every rule again; these helpers let the editor show the same answers while typing.
 */

/** The text as the customer gets it (the same rules as cart reminders). */
export const composeMarketing = composeReminder;

/** Bangla letters make a Bangla message, with the Bangla stop line. */
export function textLanguage(text: string): Locale {
  return /[ঀ-৿]/.test(text) ? 'bn' : 'en';
}

/** Stands in for the short code until the first text goes out. */
export const SAMPLE_CODE = 'Ab12Cd34';

/** What is wrong with a campaign or automation text, in the API's words, or null. */
export function marketingTextProblem(
  text: string,
  opts: {
    placeholders: readonly string[];
    maxChars: number;
    maxParts: number;
    composed: string;
    link: LinkKind;
    required: boolean;
  },
): string | null {
  const t = text.trim();
  if (!t) return opts.required ? 'Write the message' : null;
  if (t.length > opts.maxChars) return `At most ${opts.maxChars} characters`;
  const unknown = unknownPlaceholders(t, opts.placeholders);
  if (unknown.length) return `This message cannot use ${unknown.map((u) => `{${u}}`).join(', ')}`;
  if (opts.link !== 'none' && !t.includes('{link}'))
    return 'Put {link} in the message, or choose no link';
  if (opts.link === 'none' && t.includes('{link}'))
    return 'Choose where {link} goes, or take it out of the message';
  const parts = smsLength(opts.composed).parts;
  if (parts > opts.maxParts)
    return `With real values and the stop link this needs about ${parts} SMS parts; the most is ${opts.maxParts}. Make it shorter.`;
  return null;
}

/** The short link a preview shows: the store's address with a sample code (or the real one). */
export function linkPreviewUrl(
  link: LinkInput,
  options: Pick<CampaignOptions, 'stores' | 'landingPages'>,
  realUrl?: string | null,
): string {
  if (link.kind === 'none') return '';
  if (realUrl) return realUrl;
  const storeId =
    link.kind === 'landing_page'
      ? options.landingPages.find((p) => p.id === link.targetId)?.storeId
      : link.storeId;
  const store = options.stores.find((s) => s.id === storeId) ?? options.stores[0];
  return store ? `${store.url}/c/${SAMPLE_CODE}` : '';
}

/** Drops empty filters, so the API gets only what the business chose. */
export function cleanAudience(a: CampaignAudience): CampaignAudience {
  const out: CampaignAudience = { ordered: a.ordered };
  if (a.minOrders && a.minOrders > 0) out.minOrders = a.minOrders;
  if (a.minSpentMinor && a.minSpentMinor > 0) out.minSpentMinor = a.minSpentMinor;
  if (a.orderedWithinDays && a.orderedWithinDays > 0) out.orderedWithinDays = a.orderedWithinDays;
  if (a.noOrderForDays && a.noOrderForDays > 0) out.noOrderForDays = a.noOrderForDays;
  if (a.tags?.length) out.tags = a.tags;
  if (a.sources?.length) out.sources = a.sources;
  return out;
}

/** Ordered in the last N days and also not for longer than N: nobody can match. */
export function audienceProblem(a: CampaignAudience): string | null {
  if (a.orderedWithinDays && a.noOrderForDays && a.noOrderForDays >= a.orderedWithinDays)
    return 'No customer ordered in the last days and also not for longer. Change one of them.';
  return null;
}

export const SOURCE_LABEL: Record<string, string> = {
  manual: 'Added by hand',
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  webchat: 'Web chat',
  store: 'Online store',
  landing_page: 'Landing pages',
  import: 'Imported',
};

const ORDERED_LABEL: Record<CampaignAudience['ordered'], string> = {
  any: 'Every customer with a phone number',
  ordered: 'Customers who ordered',
  delivered: 'Customers with a delivered order',
};

/** "Customers who ordered · 2+ orders · spent ৳500+ · tagged vip". */
export function audienceSummary(a: CampaignAudience, currency: string): string {
  const parts = [ORDERED_LABEL[a.ordered]];
  if (a.minOrders) parts.push(`${a.minOrders}+ orders`);
  if (a.minSpentMinor) parts.push(`spent ${formatMoney(a.minSpentMinor, currency)}+`);
  if (a.orderedWithinDays) parts.push(`ordered in the last ${a.orderedWithinDays} days`);
  if (a.noOrderForDays) parts.push(`no order for ${a.noOrderForDays} days`);
  if (a.tags?.length) parts.push(`tagged ${a.tags.join(', ')}`);
  if (a.sources?.length)
    parts.push(`from ${a.sources.map((s) => SOURCE_LABEL[s] ?? s).join(', ')}`);
  return parts.join(' · ');
}

export const CAMPAIGN_STATUS: Record<
  CampaignStatus,
  { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
> = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  sending: { label: 'Sending', tone: 'info' },
  paused: { label: 'Paused', tone: 'warning' },
  sent: { label: 'Sent', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const CAMPAIGN_VIEWS = ['all', 'draft', 'scheduled', 'sending', 'paused', 'sent'] as const;
export type CampaignView = (typeof CAMPAIGN_VIEWS)[number];

export const PAUSE_TEXT: Record<CampaignPause, { title: string; text: string }> = {
  staff: { title: 'Paused', text: 'Someone paused it. Resume to send to the rest.' },
  wallet: {
    title: 'Paused: not enough wallet cash',
    text: 'The next texts cost more than your wallet cash. Top up, then resume; nobody gets the text twice.',
  },
  sms_off: {
    title: 'Paused: SMS is not working',
    text: 'SMS was turned off or cannot send right now. Fix it in Settings › SMS, then resume.',
  },
  not_in_plan: {
    title: 'Paused: campaigns are not in your plan',
    text: 'Your plan no longer includes marketing. Upgrade, then resume.',
  },
  invalid: {
    title: 'Paused: the message needs a change',
    text: 'The page the link goes to stopped being live or on sale. Resume once it is back, or cancel and send a copy with another link.',
  },
};

/** "Waiting for 9 AM (texts go out 9 AM–9 PM)" or "Today's SMS limit is used up …". */
export function waitText(
  wait: { reason: CampaignWait; until: string },
  timeZone: string,
  window: { startHour: number; endHour: number },
): string {
  const at = formatDateTime(wait.until, timeZone);
  return wait.reason === 'night'
    ? `Waiting for the morning: texts go out ${hourLabel(window.startHour)}–${hourLabel(window.endHour)}. Carries on ${at}.`
    : `Today's SMS limit is used up. Carries on ${at}.`;
}

export const RECIPIENT_SKIP: Record<NonNullable<CampaignRecipient['skip']>, string> = {
  opted_out: 'Asked to stop',
  unreachable: 'SMS cannot reach this number',
  off: 'SMS was off',
  cancelled: 'Campaign cancelled',
};

export const AUTOMATION_SKIP: Record<AutomationSkip, string> = {
  off: 'Automation was off',
  not_in_plan: 'Not in your plan',
  returned: 'Order was returned',
  opted_out: 'Asked to stop',
  late: 'More than 3 days late',
  no_phone: 'No phone number',
  ordered_again: 'Ordered again',
  blocked: 'Customer blocked',
  link_gone: 'The link page is not live',
};

/** Messages that left: sent or delivered. */
export function sentOf(byStatus: Record<SmsMessageStatus, number>): number {
  return (byStatus.sent ?? 0) + (byStatus.delivered ?? 0);
}

/** Messages still with the SMS worker. */
export function waitingOf(byStatus: Record<SmsMessageStatus, number>): number {
  return (byStatus.queued ?? 0) + (byStatus.sending ?? 0);
}

/** "1,197 customers × 1 part × ৳0.50 = ৳598.50". */
export function estimateLine(
  recipients: number,
  parts: number,
  perPartMinor: number,
  currency: string,
): string {
  const total = recipients * Math.max(1, parts) * perPartMinor;
  return `${formatNumber(recipients)} × ${Math.max(1, parts)} part${parts > 1 ? 's' : ''} × ${formatMoney(perPartMinor, currency)} = ${formatMoney(total, currency)}`;
}

// ---------------------------------------------------------------- scheduling

/** How far `timeZone` is ahead of UTC at `ms`, in ms. */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** "2026-11-05" 15:30 in `timeZone` → the moment. */
export function zonedToUtc(date: string, hour: number, minute: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  let at = guess - zoneOffset(guess, timeZone);
  // Again at the result, in case a daylight-saving change lies between.
  at = guess - zoneOffset(at, timeZone);
  return new Date(at);
}

/** The calendar day of `at` in `timeZone`, as an input's "YYYY-MM-DD". */
export function dayInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** The hour of `at` in `timeZone` (0–23). */
export function hourInZone(at: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' }).format(at),
  );
}

/** Why a schedule time cannot be used (the API's rules), or null. */
export function scheduleProblem(
  at: Date,
  timeZone: string,
  window: { startHour: number; endHour: number },
  now = new Date(),
): string | null {
  const ahead = at.getTime() - now.getTime();
  if (ahead < 5 * 60_000 || ahead > 60 * 24 * 3600_000)
    return 'Choose a time from 5 minutes to 60 days from now';
  const hour = hourInZone(at, timeZone);
  if (hour < window.startHour || hour >= window.endHour)
    return `Campaigns go out between ${hourLabel(window.startHour)} and ${hourLabel(window.endHour)}. Choose a time in those hours.`;
  return null;
}

/** Whether "send now" is inside the sending hours. */
export function canSendNow(
  timeZone: string,
  window: { startHour: number; endHour: number },
  now = new Date(),
): boolean {
  const hour = hourInZone(now, timeZone);
  return hour >= window.startHour && hour < window.endHour;
}
