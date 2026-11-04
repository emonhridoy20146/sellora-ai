import 'server-only';
import { headers } from 'next/headers';
import { cache } from 'react';
import { ApiError, apiGet, contextFrom } from './api';
import { isLandingSlug } from './landing-offer';
import { LANDING_PREVIEW_HEADER } from './request';
import type { Landing } from './types';

/**
 * The landing page at `slug` on this store, or null when there is none. Cached for the
 * request, so the layout and the page share one API call. A preview token in the page
 * address (handed over by the proxy) shows the draft or the version in review; the API
 * checks it, and it never reaches the store's own preview cookie.
 */
export const getLanding = cache(async (slug: string): Promise<Landing | null> => {
  if (!isLandingSlug(slug)) return null;
  const h = await headers();
  const preview = h.get(LANDING_PREVIEW_HEADER) ?? undefined;
  try {
    return await apiGet<Landing>(
      `/landing-pages/${encodeURIComponent(slug)}`,
      contextFrom(h, preview || undefined),
    );
  } catch (err) {
    if (err instanceof ApiError && (err.problem.status === 404 || err.problem.status === 422))
      return null;
    throw err;
  }
});
