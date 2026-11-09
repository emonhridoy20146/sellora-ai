import type { OrderAttribution } from '../commerce/schemas.js';

/**
 * Where a store visitor or an order came from, in the few groups a Bangladeshi shop asks
 * about. Read from the ad's tags (utm_source, the click ids) first, then the referring
 * site's host. "direct" means nothing said where the shopper came from.
 */
export const TRAFFIC_SOURCES = [
  'facebook',
  'instagram',
  'whatsapp',
  'google',
  'tiktok',
  'youtube',
  'sms',
  'other',
  'direct',
] as const;
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

const BY_TAG: [RegExp, TrafficSource][] = [
  [/^(ig|insta|instagram)/, 'instagram'],
  [/^(fb|facebook|meta|messenger)/, 'facebook'],
  [/^(wa|whatsapp)/, 'whatsapp'],
  [/^(google|gads|adwords)/, 'google'],
  [/^(tiktok|tt)$|^tiktok/, 'tiktok'],
  [/^(youtube|yt)$|^youtube/, 'youtube'],
  [/^sms$|^text/, 'sms'],
];

const BY_HOST: [RegExp, TrafficSource][] = [
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, 'facebook'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'whatsapp'],
  [/(^|\.)google\.[a-z.]+$/, 'google'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
];

export function trafficSource(a: OrderAttribution | undefined | null): TrafficSource {
  if (!a) return 'direct';
  const tag = a.utmSource?.trim().toLowerCase();
  if (tag) {
    for (const [re, source] of BY_TAG) if (re.test(tag)) return source;
    return 'other';
  }
  if (a.fbclid) return 'facebook';
  if (a.gclid) return 'google';
  if (a.ttclid) return 'tiktok';
  const host = a.referrer?.trim().toLowerCase();
  if (host) {
    for (const [re, source] of BY_HOST) if (re.test(host)) return source;
    return 'other';
  }
  return 'direct';
}
