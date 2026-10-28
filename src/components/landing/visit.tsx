'use client';

import { useEffect } from 'react';
import { attributionKey, readAttribution } from '@/lib/landing-offer';
import { save } from '@/lib/shopper';

const VISITOR_KEY = 'sl_vid';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** A random id this browser keeps, so a visitor is counted once a day however often they look. */
function visitorId(): string | undefined {
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

/**
 * When the page opens: remembers where the shopper came from (the ad's UTM tags and click
 * id, or the referring site) for the order form, and counts the visit. Previews and paused
 * pages count nothing; the API decides that too.
 */
export function LandingVisit({
  slug,
  pageId,
  live,
}: {
  slug: string;
  pageId: string;
  live: boolean;
}) {
  useEffect(() => {
    const found = readAttribution(window.location.search, document.referrer, window.location.host);
    // The latest ad that brought the shopper wins; a reload without tags keeps the first.
    if (Object.keys(found).length) save(attributionKey(pageId), found, 'session');
    if (!live) return;
    const id = visitorId();
    void fetch(`/api/landing/${encodeURIComponent(slug)}/visit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(id ? { visitorId: id } : {}),
    })
      // Read the (tiny) answer so the browser can close the request.
      .then((res) => res.text())
      .catch(() => {
        // Counting is best effort.
      });
  }, [slug, pageId, live]);
  return null;
}
