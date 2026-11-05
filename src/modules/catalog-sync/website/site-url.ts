import { getDomain } from 'tldts';

/**
 * Addresses on the merchant's site (ADR 0024): which links the crawler follows, and the key a
 * page (and the product on it) is remembered by.
 */

/** Query parameters that only track a visit; dropped so one page has one key. */
const TRACKING =
  /^(utm_.+|fbclid|gclid|gbraid|wbraid|msclkid|yclid|dclid|mc_cid|mc_eid|_ga|_gl|srsltid|ref|referrer|igshid)$/i;
/** Parameters that sort, filter, search or act: such lists would use up the page budget. */
const NOT_A_PAGE_PARAM =
  /^(add-to-cart|add_to_cart|remove_item|orderby|order|sort|sort_by|sortby|dir|filter|filter_.+|min_price|max_price|price|rating_filter|replytocom|share|print|s|q|query|search|keyword|session.*|sid|lang_switch|currency|view|display|limit|per_page|ajax)$/i;
const NOT_HTML =
  /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|pdf|zip|rar|7z|gz|tgz|tar|bz2|mp[34]|m4a|wav|ogg|oga|webm|mov|avi|mkv|flv|docx?|xlsx?|pptx?|odt|ods|csv|txt|xml|json|rss|atom|js|mjs|css|map|woff2?|ttf|otf|eot|apk|exe|dmg|msi|iso)$/i;
/** Paths for buying, signing in and administration, never content pages. */
const NOT_CONTENT =
  /\/(cart|basket|checkout|my-account|account|login|log-in|signin|sign-in|logout|log-out|register|signup|sign-up|wishlist|compare|wp-admin|wp-login\.php|wp-json|xmlrpc\.php|cgi-bin|feed|trackback|admin|dashboard)(\/|$)/i;

/** The site's address as stored: https (or http in development) origin and "/". */
export function normalizeSiteUrl(raw: string): string {
  let text = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const u = new URL(text);
  u.hash = '';
  u.search = '';
  u.pathname = '/';
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  return u.toString();
}

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');

/** Whether two hosts are the same site, ignoring a leading "www.". */
export function sameSite(a: string, b: string): boolean {
  return bareHost(a) === bareHost(b);
}

/** The registrable domain ("shop.com.bd" for "www.shop.com.bd"), or the host itself. */
export function registrableDomain(host: string): string {
  return getDomain(host, { allowPrivateDomains: false }) ?? host.toLowerCase();
}

/**
 * The address the crawler would fetch for a link on `site`, or null when it is not a page of
 * the site worth reading. Links to the site's other spelling (with or without www, http or
 * https) are moved onto the site's own origin.
 */
export function crawlableUrl(href: string, base: string, site: URL): URL | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!sameSite(u.hostname, site.hostname)) return null;
  if (u.port && u.port !== site.port) return null;
  u.protocol = site.protocol;
  u.hostname = site.hostname;
  u.port = site.port;
  u.hash = '';
  if (NOT_HTML.test(u.pathname) || NOT_CONTENT.test(u.pathname)) return null;
  const params = [...u.searchParams.keys()];
  for (const k of params) if (TRACKING.test(k)) u.searchParams.delete(k);
  const kept = [...u.searchParams.keys()];
  if (kept.length > 1 || kept.some((k) => NOT_A_PAGE_PARAM.test(k))) return null;
  return u;
}

/** A page's key: path and query. The product on a page is remembered by it. */
export function pageKey(u: URL): string {
  const path = u.pathname || '/';
  return `${path}${u.search}`;
}
