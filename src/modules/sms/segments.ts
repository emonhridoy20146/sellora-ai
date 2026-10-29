/**
 * How many parts (segments) an SMS takes, counted the way handsets and operators count them.
 * Text that fits the GSM 03.38 alphabet travels as 7-bit characters: 160 in one part, 153 per
 * part once it needs more (each part carries a joining header). Anything else (Bangla, most
 * emoji, curly quotes) travels as UCS-2: 70 in one part, 67 per part. A few GSM characters
 * (the "extension table") take two places.
 */

const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENSION = new Set('^{}\\[~]|€\f');

export type SmsEncoding = 'gsm' | 'unicode';

export interface SmsLength {
  encoding: SmsEncoding;
  /** Characters as the network counts them (GSM extension characters count twice). */
  units: number;
  parts: number;
  /** How many more units fit before another part is needed. */
  remaining: number;
}

/** Longest message Sellora sends: 6 Unicode parts (402 Bangla letters) or 6 GSM parts. */
export const MAX_SMS_PARTS = 6;

export function smsLength(text: string): SmsLength {
  let gsmUnits = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) gsmUnits += 1;
    else if (GSM_EXTENSION.has(ch)) gsmUnits += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return measure('gsm', gsmUnits, 160, 153);
  // UCS-2 counts UTF-16 code units: a letter outside the basic plane (most emoji) takes two.
  return measure('unicode', text.length, 70, 67);
}

function measure(encoding: SmsEncoding, units: number, single: number, multi: number): SmsLength {
  if (units <= single)
    return { encoding, units, parts: units === 0 ? 0 : 1, remaining: single - units };
  const parts = Math.ceil(units / multi);
  return { encoding, units, parts, remaining: parts * multi - units };
}

/**
 * Replaces characters that force Unicode for no visible reason (curly quotes, dashes, the
 * ellipsis, non-breaking spaces) with their plain equivalents, so English texts stay in one
 * cheap GSM part. Bangla is left alone.
 */
export function plainSmsText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}
