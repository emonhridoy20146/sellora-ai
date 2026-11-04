/** The request header the proxy fills with the page's path and query (src/proxy.ts). */
export const PATH_HEADER = 'x-sl-path';

/**
 * Where to send a shopper who reached an open store at another of its addresses (its
 * Sellora subdomain, or a custom domain that is not the main one), or null to stay. The
 * target is always on the store's main address: the path is only ever a path.
 */
export function mainAddressRedirect(
  storeUrl: string,
  requestHost: string | null,
  path: string | null,
): string | null {
  if (!requestHost) return null;
  let main: URL;
  try {
    main = new URL(storeUrl);
  } catch {
    return null;
  }
  if (main.host.toLowerCase() === requestHost.toLowerCase()) return null;
  const target = new URL(main.origin);
  if (path?.startsWith('/') && !path.startsWith('//')) {
    const asked = new URL(path, main.origin);
    if (asked.origin === main.origin) {
      target.pathname = asked.pathname;
      target.search = asked.search;
    }
  }
  return target.toString();
}
