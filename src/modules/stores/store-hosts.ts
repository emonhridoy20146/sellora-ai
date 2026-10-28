import { isReservedSlug } from '../../common/utils/slug.js';

/**
 * Store addresses. Every store gets `<handle>.<STOREFRONT_BASE_DOMAIN>`; the base domain may
 * carry a port in development (sellora.localhost:3100). Handles are DNS labels: 3 to 32
 * lowercase letters, digits and single hyphens, not starting or ending with a hyphen.
 */
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;

const RESERVED_HANDLES = new Set([
  'account',
  'accounts',
  'ads',
  'buy',
  'cart',
  'checkout',
  'demo',
  'email',
  'files',
  'images',
  'img',
  'media',
  'my',
  'news',
  'official',
  'order',
  'orders',
  'pay',
  'payment',
  'payments',
  'preview',
  'secure',
  'seller',
  'sellers',
  'shopping',
  'track',
  'tracking',
  'verify',
]);

export type HandleProblem = 'format' | 'reserved';

export function normalizeHandle(input: string): string {
  return input.trim().toLowerCase();
}

/** Why a handle cannot be used, or null when it is fine (availability aside). */
export function handleProblem(handle: string): HandleProblem | null {
  if (!HANDLE_RE.test(handle) || handle.includes('--')) return 'format';
  if (isReservedSlug(handle) || RESERVED_HANDLES.has(handle)) return 'reserved';
  return null;
}

export const HANDLE_MESSAGES: Record<HandleProblem, string> = {
  format: 'Use 3 to 32 lowercase letters, numbers and single hyphens',
  reserved: 'This address is kept for Sellora; choose another',
};

export function storeHost(handle: string, baseDomain: string): string {
  return `${handle}.${baseDomain.toLowerCase()}`;
}

export function storeUrl(handle: string, baseDomain: string, scheme: 'http' | 'https'): string {
  return `${scheme}://${storeHost(handle, baseDomain)}`;
}

export type ParsedHost = { kind: 'handle'; handle: string } | { kind: 'custom'; host: string };

/**
 * What a request's Host header points at: one of our store subdomains, or a domain of its
 * own. The bare base domain, nested subdomains and malformed hosts point at nothing.
 */
export function parseStoreHost(rawHost: string, baseDomain: string): ParsedHost | null {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 260 || !/^[a-z0-9.:-]+$/.test(host)) return null;
  const base = baseDomain.toLowerCase();
  if (host === base) return null;
  const suffix = `.${base}`;
  if (host.endsWith(suffix)) {
    const label = host.slice(0, -suffix.length);
    return HANDLE_RE.test(label) && !label.includes('.') ? { kind: 'handle', handle: label } : null;
  }
  return { kind: 'custom', host };
}
