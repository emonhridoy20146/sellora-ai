import { createHash } from 'node:crypto';

/**
 * Normalizing and hashing shopper details the way the ad platforms document it (ADR 0030):
 * trimmed and lower-cased, then SHA-256 in hex. Click and browser ids (fbp, fbc, ttp,
 * ttclid, GA client id), IP addresses and user agents are sent as they are.
 */

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Lower case, no surrounding spaces; undefined when nothing is left. */
export function normEmail(email: string | undefined): string | undefined {
  const e = email?.trim().toLowerCase();
  return e && e.includes('@') ? e : undefined;
}

/**
 * A phone number in E.164 (+8801712345678). Bangladeshi numbers written locally
 * (01712345678, 8801712345678) are completed with the country code; anything else that is
 * not already international is dropped rather than guessed.
 */
export function e164(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (/^01[3-9]\d{8}$/.test(digits)) return `+88${digits}`;
  if (/^8801[3-9]\d{8}$/.test(digits)) return `+${digits}`;
  return undefined;
}

/** Meta's phone form: the E.164 digits without the plus sign. */
export function metaPhone(phone: string | undefined): string | undefined {
  return e164(phone)?.slice(1);
}

/** Names and cities: lower case, without spaces or punctuation (any script kept). */
export function normWord(value: string | undefined): string | undefined {
  const v = value
    ?.normalize('NFC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
  return v || undefined;
}

/** "Rahim Uddin Ahmed" → first "Rahim", last "Uddin Ahmed". */
export function splitName(name: string | undefined): { first?: string; last?: string } {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!parts.length) return {};
  return parts.length === 1
    ? { first: parts[0] }
    : { first: parts[0], last: parts.slice(1).join(' ') };
}

export const hashed = (v: string | undefined): string | undefined =>
  v === undefined ? undefined : sha256Hex(v);

/** Meta's fbc from a click id when the browser has no _fbc cookie (subdomain index 1). */
export function fbcFromClickId(fbclid: string | undefined, atMs: number): string | undefined {
  if (!fbclid || !/^[\w-]{4,500}$/.test(fbclid)) return undefined;
  return `fb.1.${atMs}.${fbclid}`;
}

const FB_ID = /^fb\.[0-2]\.\d{10,13}\.[\w-]{1,500}$/;
const TTP = /^[\w.-]{8,200}$/;

export const validFbId = (v: string | undefined): string | undefined =>
  v && FB_ID.test(v) ? v : undefined;
export const validTtp = (v: string | undefined): string | undefined =>
  v && TTP.test(v) ? v : undefined;

/**
 * GA4's client id from the `_ga` cookie ("GA1.1.123456789.1700000000" → "123456789.1700000000");
 * a bare "123.456" is taken as it is.
 */
export function gaClientId(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  const m = /^(?:GA\d\.\d\.)?(\d{1,20}\.\d{1,20})$/.exec(cookie.trim());
  return m?.[1];
}

/**
 * GA4's session id from the `_ga_<container>` cookie, in either the older
 * ("GS1.1.1700000000.3.1...") or the newer ("GS2.1.s1700000000$o3$g1...") form.
 */
export function gaSessionId(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  const v = cookie.trim();
  const newer = /^GS2\.\d\.s(\d{6,20})(?:\$|$)/.exec(v);
  if (newer) return newer[1];
  const older = /^GS1\.\d\.(\d{6,20})\./.exec(v);
  return older?.[1];
}

/** A GA4 client id made from Sellora's own id, for orders no browser was part of. */
export function gaClientIdFrom(seed: string): string {
  const h = sha256Hex(seed);
  return `${parseInt(h.slice(0, 8), 16)}.${parseInt(h.slice(8, 16), 16)}`;
}

/** Money for the platforms: major units with two decimals (taka, not poisha). */
export const major = (minor: number): number => Math.round(minor) / 100;
