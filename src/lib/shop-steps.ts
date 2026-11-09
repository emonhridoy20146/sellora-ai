'use client';

import { readAttribution } from './landing-offer';
import { load, save } from './shopper';
import type { Attribution } from './types';

const VISITOR_KEY = 'sl_vid';
const ATTRIBUTION_KEY = 'sl_store_attr';
const VISIT_KEY = 'sl_store_visit';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export type ShopStep = 'visit' | 'product_view' | 'cart_add' | 'checkout';

/** A random id this browser keeps, so a shopper is counted once a day however often they look. */
export function visitorId(): string | undefined {
  try {
    const kept = localStorage.getItem(VISITOR_KEY);
    if (kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept)) return kept;
    const bytes = crypto.getRandomValues(new Uint8Array(22));
    const id = Array.from(bytes, (b) => ALPHABET[b % 64]).join('');
    localStorage.setItem(VISITOR_KEY, id);
    return id;
  } catch {
    // No storage: the shopper's address stands in on the server.
    return undefined;
  }
}

/** Where this visit to the store came from, kept for the checkout in this browser tab. */
export function storeAttribution(): Attribution | null {
  return load<Attribution>(ATTRIBUTION_KEY, 'session');
}

/** Sends one step to the store's numbers. Best effort: a lost step is never shown to anyone. */
export function reportStep(
  type: ShopStep,
  extra: { productId?: string; attribution?: Attribution } = {},
) {
  const id = visitorId();
  void fetch('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, ...(id ? { visitorId: id } : {}), ...extra }),
    keepalive: true,
  })
    // Read the (tiny) answer so the browser can close the request.
    .then((res) => res.text())
    .catch(() => {
      // Counting is best effort.
    });
}

/**
 * On every page of an open store: remembers the ad or site that brought the shopper (the
 * latest one with tags wins), and counts the visit once per tab and day; the API counts a
 * shopper once a day whatever the browser sends.
 */
export function noteVisit(now = new Date()) {
  const found = readAttribution(window.location.search, document.referrer, window.location.host);
  if (Object.keys(found).length) save(ATTRIBUTION_KEY, found, 'session');
  const day = now.toISOString().slice(0, 10);
  if (load<string>(VISIT_KEY, 'session') === day) return;
  save(VISIT_KEY, day, 'session');
  const attribution = storeAttribution();
  reportStep('visit', attribution ? { attribution } : {});
}
