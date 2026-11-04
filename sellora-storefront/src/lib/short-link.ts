/** The 8-letter codes in campaign and automation texts (`<store>/c/<code>`, ADR 0019). */
export const SHORT_CODE_RE = /^[A-Za-z0-9]{8}$/;

/** What the API answers for a short link: the page on this store and its tracking tags. */
export interface ShortLinkTarget {
  path: string;
  query: Record<string, string>;
}

/**
 * The address to send the shopper on to, on this store: the page with its tracking tags.
 * Anything that is not a path on this store (the API never sends one) goes to the home page.
 */
export function shortLinkLocation(target: unknown): string {
  const t = target as Partial<ShortLinkTarget> | null;
  const path = typeof t?.path === 'string' ? t.path : '/';
  const safe = path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(t?.query ?? {})) if (typeof v === 'string') q.set(k, v);
  const query = q.toString();
  return query ? `${safe}?${query}` : safe;
}
