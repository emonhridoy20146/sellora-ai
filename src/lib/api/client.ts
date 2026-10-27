import { readCookie } from '@/lib/utils';
import { ApiError } from './errors';

export type Realm = 'merchant' | 'platform';

const CSRF_COOKIE: Record<Realm, string> = { merchant: 'sl_csrf', platform: 'slp_csrf' };
const REFRESH_PATH: Record<Realm, string> = {
  merchant: '/v1/auth/refresh',
  platform: '/v1/platform/auth/refresh',
};
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  realm?: Realm;
  signal?: AbortSignal;
  /** Do not try a token refresh on 401 (used by the refresh and sign-in calls themselves). */
  noRefresh?: boolean;
}

/** Called when a session can no longer be refreshed, so the app can send the user to sign in. */
const sessionListeners = new Set<(realm: Realm) => void>();
export function onSessionExpired(fn: (realm: Realm) => void): () => void {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

const inflightRefresh: Partial<Record<Realm, Promise<boolean>>> = {};

function refresh(realm: Realm): Promise<boolean> {
  inflightRefresh[realm] ??= (async () => {
    try {
      const res = await fetch(REFRESH_PATH[realm], {
        method: 'POST',
        credentials: 'same-origin',
        headers: csrfHeaders(realm, { 'content-type': 'application/json' }),
        body: '{}',
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      // Let the next expiry start a new refresh.
      setTimeout(() => delete inflightRefresh[realm], 0);
    }
  })();
  return inflightRefresh[realm];
}

function csrfHeaders(realm: Realm, headers: Record<string, string>): Record<string, string> {
  const token = readCookie(CSRF_COOKIE[realm]);
  return token ? { ...headers, 'x-csrf-token': token } : headers;
}

export function buildUrl(path: string, query?: Query): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return `/v1${path}${s ? `?${s}` : ''}`;
}

/**
 * Calls the Sellora API through this site's /v1 proxy. Auth rides on httpOnly cookies; the
 * CSRF cookie is echoed in a header for writes. An expired access token is refreshed once,
 * then the call is retried.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const realm = opts.realm ?? (path.startsWith('/platform') ? 'platform' : 'merchant');
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const send = async () => {
    let headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (!SAFE.has(method)) headers = csrfHeaders(realm, headers);
    return fetch(buildUrl(path, opts.query), {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  };

  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && !opts.noRefresh) {
      if (await refresh(realm)) res = await send();
      else sessionListeners.forEach((fn) => fn(realm));
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw ApiError.network();
  }
  if (!res.ok) throw await ApiError.from(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
