import type { BadgeTone } from '@/components/ui/badge';
import type {
  AdDestination,
  AdEventLogEntry,
  AdEventName,
  AdPlatformDescriptor,
  AdTrackingSites,
} from './api/types';

/** What each event is called on the Settings page. */
export const AD_EVENT_LABEL: Record<AdEventName, string> = {
  PageView: 'page views',
  ViewContent: 'product views',
  AddToCart: 'add to cart',
  InitiateCheckout: 'checkout started',
  Purchase: 'purchases',
  Refund: 'refunds',
};

/** One event in the log of what was sent. */
export const AD_EVENT_ONE: Record<AdEventName, string> = {
  PageView: 'Page view',
  ViewContent: 'Product view',
  AddToCart: 'Add to cart',
  InitiateCheckout: 'Checkout started',
  Purchase: 'Purchase',
  Refund: 'Refund',
};

/** Ids as the platforms show them: GA4, TikTok and Google Ads ids in capitals, no spaces. */
export function cleanPublicId(d: Pick<AdPlatformDescriptor, 'key'>, raw: string): string {
  const v = raw.trim().replace(/\s+/g, '');
  return d.key === 'meta' ? v : v.toUpperCase();
}

/** Checks the id with the platform's pattern (the same one the API uses). */
export function publicIdError(
  d: Pick<AdPlatformDescriptor, 'key' | 'name' | 'publicIdLabel' | 'publicIdPattern'>,
  raw: string,
): string | undefined {
  const v = cleanPublicId(d, raw);
  if (!v) return `Enter the ${d.publicIdLabel}`;
  if (!new RegExp(d.publicIdPattern).test(v)) return `This is not a ${d.name} ${d.publicIdLabel}`;
  return undefined;
}

/** "product views, add to cart and purchases" */
export function listEvents(events: AdEventName[]): string {
  const words = events.map((e) => AD_EVENT_LABEL[e]);
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** Where a tracking id loads, in a few words. */
export function whereUsed(
  d: Pick<AdDestination, 'everywhere' | 'storeIds' | 'landingPageIds'>,
  sites: AdTrackingSites,
): string {
  if (d.everywhere) return 'Your store and every landing page';
  const stores = sites.stores.filter((s) => d.storeIds.includes(s.id));
  const pages = sites.landingPages.filter((p) => d.landingPageIds.includes(p.id));
  const parts: string[] = [];
  if (stores.length) parts.push(stores.length === 1 ? stores[0]!.name : `${stores.length} stores`);
  if (pages.length)
    parts.push(
      pages.length === 1 ? `the landing page ${pages[0]!.name}` : `${pages.length} landing pages`,
    );
  if (!parts.length) return 'Nowhere yet: choose a store or landing page';
  const text = parts.join(' and ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What reaches the platform: the browser tag alone, or a server copy too. */
export function whatIsSent(
  desc: Pick<AdPlatformDescriptor, 'key' | 'serverEvents' | 'secretLabel'>,
  d: Pick<AdDestination, 'hasSecret' | 'chatOrders' | 'purchaseWhen'>,
): string {
  if (desc.key === 'google_ads')
    return 'Purchases from the shopper’s browser, with hashed email and phone (enhanced conversions).';
  if (desc.key === 'ga4')
    return d.hasSecret
      ? `Page views, product views, cart and checkout from the shopper’s browser; ${d.purchaseWhen === 'delivered' ? 'purchases once delivered' : 'purchases'} and refunds from the server${d.chatOrders ? ', inbox orders too' : ''}.`
      : 'Page views, product views, cart and checkout from the shopper’s browser. Purchases need the API secret.';
  if (!d.hasSecret) return 'From the shopper’s browser only (blocked by some ad blockers).';
  const counted =
    d.purchaseWhen === 'delivered' ? 'purchases once the order is delivered' : 'purchases';
  const events = desc.serverEvents
    .filter((e) => e !== 'Purchase' && e !== 'Refund')
    .map((e) => AD_EVENT_LABEL[e]);
  const server = [...events, counted];
  const list =
    server.length > 1 ? `${server.slice(0, -1).join(', ')} and ${server.at(-1)}` : server[0];
  return `Browser and server: ${list}${d.chatOrders ? ', and inbox orders' : ''}.`;
}

export function destinationBadge(d: AdDestination): { label: string; tone: BadgeTone } {
  if (!d.enabled) return { label: 'Off', tone: 'neutral' };
  if (d.lastError) return { label: 'Last server event failed', tone: 'danger' };
  if (d.lastCheck.state === 'failed') return { label: 'Key refused', tone: 'danger' };
  return { label: 'On', tone: 'success' };
}

export const LOG_SOURCE: Record<AdEventLogEntry['source'], string> = {
  browser: 'Shopper’s visit',
  order: 'Order',
  test: 'Test',
};

/** The 7-day counts in a sentence. */
export function weekLine(week: AdDestination['week']): string {
  const sent = week?.sent ?? 0;
  const failed = week?.failed ?? 0;
  if (!sent && !failed) return 'No server events in the last 7 days';
  return `${sent} sent${failed ? `, ${failed} failed` : ''} in the last 7 days`;
}
