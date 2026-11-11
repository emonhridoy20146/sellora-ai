'use client';

import { useEffect } from 'react';
import { attributionKey, readAttribution } from '@/lib/landing-offer';
import { visitorId } from '@/lib/shop-steps';
import { save } from '@/lib/shopper';
import type { LandingProduct } from '@/lib/types';
import { useAdTags } from '../ad-tags';

/**
 * When the page opens: remembers where the shopper came from (the ad's UTM tags and click
 * id, or the referring site) for the order form, and counts the visit. Previews and paused
 * pages count nothing; the API decides that too. The business's ad tags get a product view.
 */
export function LandingVisit({
  slug,
  pageId,
  live,
  product,
}: {
  slug: string;
  pageId: string;
  live: boolean;
  product: LandingProduct | null;
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

  // A product view for the ad tags (none in previews: the provider has no tags then).
  const ads = useAdTags();
  const shown = product ? (product.variants.find((v) => v.available) ?? product.variants[0]) : null;
  const productId = product?.id;
  const productName = product?.name;
  useEffect(() => {
    if (!productId || !shown) return;
    ads.track('ViewContent', [
      {
        productId,
        variantId: shown.id,
        name: productName ?? '',
        quantity: 1,
        priceMinor: shown.priceMinor,
      },
    ]);
  }, [ads, productId, productName, shown]);
  return null;
}
