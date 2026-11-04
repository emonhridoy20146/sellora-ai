import type { FieldError } from '../../common/errors/app-error.js';
import { optOutSuffix } from '../carts/cart-templates.js';
import { MAX_SMS_PARTS, smsLength } from '../sms/segments.js';
import { renderSms, unknownPlaceholders, type SmsLanguage } from '../sms/templates.js';
import type { LinkChoice } from './schemas.js';

/** Bangla letters in a text make it a Bangla message (and its stop line Bangla too). */
export function textLanguage(text: string): SmsLanguage {
  return /[ঀ-৿]/.test(text) ? 'bn' : 'en';
}

/**
 * The text as the customer gets it: values filled in, punctuation an empty `{name}` leaves at
 * the start dropped, English capitalised, and the stop link added.
 */
export function composeMarketing(
  text: string,
  values: Record<string, string>,
  language: SmsLanguage,
  stopUrl: string,
): string {
  let body = renderSms(text, values).replace(/^[\s,،।.:;-]+/, '');
  if (language === 'en' && body) body = body[0]!.toUpperCase() + body.slice(1);
  return `${body}${optOutSuffix(language, stopUrl)}`;
}

/** What is wrong with a marketing text, with field paths, given its link and placeholders. */
export function textProblems(
  text: string,
  opts: {
    path: string;
    placeholders: readonly string[];
    link: LinkChoice;
    maxChars: number;
    /** The text with sample values and the stop link, to count parts. */
    composed: string;
    required: boolean;
  },
): FieldError[] {
  const t = text.trim();
  const at = (message: string): FieldError[] => [{ path: opts.path, message }];
  if (!t) return opts.required ? at('Write the message') : [];
  if (t.length > opts.maxChars) return at(`At most ${opts.maxChars} characters`);
  const unknown = unknownPlaceholders(t, opts.placeholders);
  if (unknown.length)
    return at(`This message cannot use ${unknown.map((u) => `{${u}}`).join(', ')}`);
  if (opts.link.kind !== 'none' && !t.includes('{link}'))
    return at('Put {link} in the message, or choose no link');
  if (opts.link.kind === 'none' && t.includes('{link}'))
    return at('Choose where {link} goes, or take it out of the message');
  const parts = smsLength(opts.composed).parts;
  if (parts > MAX_SMS_PARTS)
    return at(
      `With real values and the stop link this needs about ${parts} SMS parts; the most is ${MAX_SMS_PARTS}. Make it shorter.`,
    );
  return [];
}
