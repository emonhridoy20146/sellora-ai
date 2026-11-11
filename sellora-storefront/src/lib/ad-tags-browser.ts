'use client';

/**
 * Loads the business's own tags in the shopper's browser with each platform's standard
 * snippet (the same code Meta, TikTok and Google give businesses to paste), and reports
 * events to them. Only called once the shopper may be tracked (see `mayTrack`).
 */
import {
  GTAG_EVENT,
  gtagData,
  metaData,
  purchaseItems,
  purchaseTargets,
  tiktokData,
  type AdBrowserEvent,
  type AdItem,
} from './ad-tags';
import type { AdTags, BrowserPurchase } from './types';

type Queue = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push: Queue;
  loaded: boolean;
  version: string;
  disablePushState?: boolean;
};

interface TikTokQueue extends Array<unknown> {
  methods: string[];
  setAndDefer: (target: Record<string, unknown>, method: string) => void;
  instance: (code: string) => Record<string, (...args: unknown[]) => void>;
  load: (code: string) => void;
  page: () => void;
  _i?: Record<string, unknown[] & { _u?: string }>;
  _t?: Record<string, number>;
  _o?: Record<string, unknown>;
}

interface TagWindow {
  fbq?: Queue;
  _fbq?: Queue;
  ttq?: TikTokQueue;
  TiktokAnalyticsObject?: string;
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
}

const w = () => window as unknown as TagWindow;

function addScript(src: string) {
  if (document.querySelector(`script[src="${src}"]`)) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = src;
  document.head.appendChild(s);
}

/** Meta's pixel base code, then each pixel. Page views are reported by `pageView`. */
function loadMeta(pixelIds: string[]) {
  const win = w();
  if (!win.fbq) {
    const n = function (...args: unknown[]) {
      if (n.callMethod) n.callMethod(...args);
      else n.queue.push(args);
    } as Queue;
    n.push = n;
    n.loaded = true;
    n.version = '2.0';
    n.queue = [];
    // Sellora reports page changes itself, so the pixel must not count them a second time.
    n.disablePushState = true;
    win.fbq = n;
    win._fbq ??= n;
    addScript('https://connect.facebook.net/en_US/fbevents.js');
  }
  for (const id of pixelIds) win.fbq('init', id);
}

/** TikTok's pixel base code, then each pixel. */
function loadTikTok(codes: string[]) {
  const win = w();
  if (!win.ttq) {
    win.TiktokAnalyticsObject = 'ttq';
    const ttq = [] as unknown as TikTokQueue;
    ttq.methods = [
      'page',
      'track',
      'identify',
      'instances',
      'debug',
      'on',
      'off',
      'once',
      'ready',
      'alias',
      'group',
      'enableCookie',
      'disableCookie',
      'holdConsent',
      'revokeConsent',
      'grantConsent',
    ];
    ttq.setAndDefer = (target, method) => {
      target[method] = (...args: unknown[]) => {
        (target as unknown as unknown[]).push([method, ...args]);
      };
    };
    for (const m of ttq.methods) ttq.setAndDefer(ttq as unknown as Record<string, unknown>, m);
    ttq.instance = (code) => {
      const e = (ttq._i?.[code] ?? []) as unknown as Record<string, (...a: unknown[]) => void>;
      for (const m of ttq.methods) ttq.setAndDefer(e as unknown as Record<string, unknown>, m);
      return e;
    };
    ttq.load = (code) => {
      const src = 'https://analytics.tiktok.com/i18n/pixel/events.js';
      ttq._i ??= {};
      ttq._i[code] = [] as unknown[] & { _u?: string };
      ttq._i[code]._u = src;
      ttq._t ??= {};
      ttq._t[code] = Date.now();
      ttq._o ??= {};
      ttq._o[code] = {};
      addScript(`${src}?sdkid=${encodeURIComponent(code)}&lib=ttq`);
    };
    win.ttq = ttq;
  }
  for (const code of codes) win.ttq.load(code);
}

/** Google's tag (gtag.js) for GA4 and Google Ads, with consent granted (the shopper agreed). */
function loadGtag(ids: string[]) {
  const win = w();
  if (!win.gtag) {
    win.dataLayer ??= [];
    win.gtag = function gtag() {
      // gtag.js reads the arguments object itself, as Google's snippet pushes it.
      // eslint-disable-next-line prefer-rest-params
      win.dataLayer!.push(arguments);
    };
    win.gtag('consent', 'default', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted',
    });
    win.gtag('js', new Date());
    addScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ids[0]!)}`);
  }
  for (const id of ids) win.gtag('config', id);
}

const loaded = new Set<string>();

/** Loads every tag of the page once, and reports the first page view. */
export function loadTags(tags: AdTags) {
  const meta = tags.meta.map((m) => m.pixelId).filter((id) => !loaded.has(`m:${id}`));
  const tiktok = tags.tiktok.map((t) => t.pixelCode).filter((id) => !loaded.has(`t:${id}`));
  const google = [
    ...tags.ga4.map((g) => g.measurementId),
    ...tags.googleAds.map((g) => g.conversionId),
  ].filter((id) => !loaded.has(`g:${id}`));
  if (meta.length) loadMeta(meta);
  if (tiktok.length) loadTikTok(tiktok);
  // gtag's config sends GA4's own first page view.
  if (google.length) loadGtag(google);
  meta.forEach((id) => loaded.add(`m:${id}`));
  tiktok.forEach((id) => loaded.add(`t:${id}`));
  google.forEach((id) => loaded.add(`g:${id}`));
}

/**
 * A page view after the shopper moved within the site. GA4 counts these itself (enhanced
 * measurement follows the address), so only Meta and TikTok are told.
 */
export function pageView(tags: AdTags) {
  const win = w();
  if (tags.meta.length) win.fbq?.('track', 'PageView');
  if (tags.tiktok.length) win.ttq?.page();
}

/** A product view, add to cart or checkout start, with the id the server copy shares. */
export function reportEvent(
  tags: AdTags,
  event: AdBrowserEvent,
  eventId: string,
  items: AdItem[],
  currency: string,
) {
  const win = w();
  for (const m of tags.meta)
    win.fbq?.('trackSingle', m.pixelId, event, metaData(items, currency), { eventID: eventId });
  for (const t of tags.tiktok)
    win.ttq?.instance(t.pixelCode).track?.(event, tiktokData(items, currency), {
      event_id: eventId,
    });
  if (tags.ga4.length)
    win.gtag?.('event', GTAG_EVENT[event], {
      ...gtagData(items, currency),
      send_to: tags.ga4.map((g) => g.measurementId),
    });
}

/** The purchase, once, with the server's event id (each platform counts it once). */
export function reportPurchase(tags: AdTags, p: BrowserPurchase) {
  const win = w();
  const targets = purchaseTargets(tags);
  const items = purchaseItems(p);
  const value = p.valueMinor / 100;
  for (const id of targets.meta)
    win.fbq?.(
      'trackSingle',
      id,
      'Purchase',
      { ...metaData(items, p.currency), value, order_id: p.orderNumber },
      { eventID: p.eventId },
    );
  for (const code of targets.tiktok)
    win.ttq
      ?.instance(code)
      .track?.(
        'Purchase',
        { ...tiktokData(items, p.currency), value, order_id: p.orderNumber },
        { event_id: p.eventId },
      );
  if (targets.googleAds.length) {
    // Enhanced conversions: only hashed details, never the shopper's email or phone itself.
    const userData = {
      ...(p.hashedEmail ? { sha256_email_address: p.hashedEmail } : {}),
      ...(p.hashedPhone ? { sha256_phone_number: p.hashedPhone } : {}),
    };
    if (Object.keys(userData).length) win.gtag?.('set', 'user_data', userData);
    for (const sendTo of targets.googleAds)
      win.gtag?.('event', 'conversion', {
        send_to: sendTo,
        value,
        currency: p.currency,
        transaction_id: p.orderNumber,
      });
  }
}
