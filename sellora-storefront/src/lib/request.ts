/**
 * The shopper's address from X-Forwarded-For. Each proxy appends the address it saw, so
 * only the last `hops` entries were written by proxies we run; anything further left was
 * sent by the client and could be made up.
 */
export function clientIp(
  forwardedFor: string | null,
  realIp: string | null,
  hops: number,
): string | undefined {
  const forwarded = forwardedFor
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (forwarded?.length && hops > 0) return forwarded[Math.max(0, forwarded.length - hops)];
  return realIp?.trim() || undefined;
}

/** True when a browser request's Origin is this shop (or the browser sent none). */
export function sameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    // "null" (sandboxed frames, some redirects) or junk.
    return false;
  }
}

/** The request header the proxy fills with a landing page's ?preview= token (src/proxy.ts). */
export const LANDING_PREVIEW_HEADER = 'x-sl-landing-preview';
