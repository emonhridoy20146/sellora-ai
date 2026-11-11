/**
 * Ad tracking for stores and landing pages (ADR 0030): the business's own Meta Pixel,
 * TikTok Pixel, Google Analytics 4 and Google Ads tags in the shopper's browser, and the
 * same events sent from the server (Meta Conversions API, TikTok Events API, GA4 Measurement
 * Protocol) with the same event ids, so each platform counts them once.
 */

export const AD_PLATFORMS = ['meta', 'tiktok', 'ga4', 'google_ads'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

/** Sellora's own names for shopper events; each platform maps them to its own. */
export const AD_EVENT_NAMES = [
  'PageView',
  'ViewContent',
  'AddToCart',
  'InitiateCheckout',
  'Purchase',
  'Refund',
] as const;
export type AdEventName = (typeof AD_EVENT_NAMES)[number];

/** Events the browser reports for a server copy; Purchase comes from the order itself. */
export const BROWSER_COPY_EVENTS = ['ViewContent', 'AddToCart', 'InitiateCheckout'] as const;
export type BrowserCopyEvent = (typeof BROWSER_COPY_EVENTS)[number];

/** When an order counts as a purchase for a destination. */
export const PURCHASE_WHEN = ['placed', 'delivered'] as const;
export type PurchaseWhen = (typeof PURCHASE_WHEN)[number];

/** Off: pixels load for every shopper. Ask: nothing loads or is sent until the shopper agrees. */
export const CONSENT_MODES = ['off', 'ask'] as const;
export type ConsentMode = (typeof CONSENT_MODES)[number];

/** Where the event happened, in Meta's words (`action_source`). */
export type AdActionSource = 'website' | 'chat' | 'phone_call' | 'system_generated' | 'other';

export interface AdEventItem {
  id: string;
  name: string;
  quantity: number;
  priceMinor: number;
}

/**
 * Who the event is about, before any hashing. Each platform normalizes and hashes what it
 * needs; nothing here is ever stored or logged.
 */
export interface AdEventUser {
  email?: string;
  /** E.164, for example +8801712345678. */
  phone?: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  /** ISO 3166-1 alpha-2, lower case. */
  country?: string;
  /** Sellora's own id for the person (customer id or the browser's visitor id). */
  externalId?: string;
  ip?: string;
  userAgent?: string;
  fbp?: string;
  fbc?: string;
  ttp?: string;
  ttclid?: string;
  gaClientId?: string;
  gaSessionId?: string;
}

export interface AdEvent {
  name: AdEventName;
  /** Shared with the browser's copy, so the platform counts the event once. */
  eventId: string;
  /** Unix seconds. */
  time: number;
  actionSource: AdActionSource;
  url?: string;
  referrer?: string;
  currency: string;
  valueMinor?: number;
  items: AdEventItem[];
  orderId?: string;
  /** The order number shoppers see; GA4's transaction id. */
  orderNumber?: string;
  user: AdEventUser;
  /** The shopper agreed to tracking (or the business does not ask). */
  consent: boolean;
  /** A test from Settings › Ad tracking: sent with the destination's test code. */
  test?: boolean;
}

/** What a platform needs from a destination to send an event. */
export interface AdSendTarget {
  publicId: string;
  secret: string;
  testCode?: string;
}

/** A platform refused or could not take an event. `retry` when trying again may help. */
export class AdPlatformError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'AdPlatformError';
  }
}

export type AdFetch = typeof fetch;
export const AD_FETCH = Symbol('AD_FETCH');

/** How long Sellora waits for an ad platform before trying again later. */
export const AD_TIMEOUT_MS = 10_000;

export interface AdPlatformDescriptor {
  key: AdPlatform;
  name: string;
  /** What the public id is called in the platform's own screens. */
  publicIdLabel: string;
  publicIdHint: string;
  publicIdPattern: RegExp;
  /** The server key, when the platform takes server events. */
  secretLabel: string | null;
  secretHint: string | null;
  /** The test code field, when the platform has one. */
  testCodeLabel: string | null;
  /** Google Ads only: the purchase conversion's label. */
  conversionLabel: boolean;
  /** Events the server sends for this platform. */
  serverEvents: readonly AdEventName[];
  /** Orders from the inbox or added by hand can be sent (no browser involved). */
  chatOrders: boolean;
}
