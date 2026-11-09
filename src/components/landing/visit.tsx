'use client';

import { useEffect } from 'react';
import { attributionKey, readAttribution } from '@/lib/landing-offer';
import { visitorId } from '@/lib/shop-steps';
import { save } from '@/lib/shopper';

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
