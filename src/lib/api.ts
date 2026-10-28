import 'server-only';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { clientIp } from './request';
import type { Problem, Store } from './types';

const API_URL = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
/** Proxies in front of this app (Caddy: 1). The shopper's address is that many from the right. */
const PROXY_HOPS = Math.max(0, Number(process.env.TRUST_PROXY_HOPS ?? '1') || 0);

export const PREVIEW_COOKIE = 'sl_preview';

/** An error answer from the API, with its problem details. */
export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail);
    this.name = 'ApiError';
  }
}

/** What the API needs to know about the shopper's request. */
export interface ShopContext {
  host: string;
  preview?: string;
  ip?: string;
  userAgent?: string;
}

/** The shopper's address, from the proxy's X-Forwarded-For (never trusted beyond PROXY_HOPS). */
export function shopperIp(h: Headers): string | undefined {
  return clientIp(h.get('x-forwarded-for'), h.get('x-real-ip'), PROXY_HOPS);
}

export function contextFrom(h: Headers, preview: string | undefined): ShopContext {
  const ip = shopperIp(h);
  return {
    host: h.get('host') ?? '',
    ...(preview ? { preview } : {}),
    ...(ip ? { ip } : {}),
    ...(h.get('user-agent') ? { userAgent: h.get('user-agent')!.slice(0, 300) } : {}),
  };
}

/** The current page request's shop context (server components). */
export const shopContext = cache(async (): Promise<ShopContext> => {
  const [h, c] = await Promise.all([headers(), cookies()]);
  return contextFrom(h, c.get(PREVIEW_COOKIE)?.value);
});

export interface CallOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: string;
}

/** Calls the storefront API as this shop. Returns the status and JSON body as they came. */
export async function callApi(
  ctx: ShopContext,
  path: string,
  opts: CallOptions = {},
): Promise<{ status: number; body: unknown }> {
  const key = process.env.STOREFRONT_API_KEY;
  if (!key) throw new Error('STOREFRONT_API_KEY is not set');
  const res = await fetch(`${API_URL}/v1/storefront${path}`, {
    method: opts.method ?? 'GET',
    cache: 'no-store',
    headers: {
      'x-storefront-key': key,
      'x-store-host': ctx.host,
      ...(ctx.preview ? { 'x-store-preview': ctx.preview } : {}),
      ...(ctx.ip ? { 'x-shopper-ip': ctx.ip } : {}),
      ...(ctx.userAgent ? { 'x-shopper-agent': ctx.userAgent } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      accept: 'application/json',
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { status: res.status, code: 'bad_response', detail: 'The shop could not answer.' };
  }
  return { status: res.status, body };
}

/** GET for server components: the data, or an ApiError. */
export async function apiGet<T>(path: string, ctx?: ShopContext): Promise<T> {
  const res = await callApi(ctx ?? (await shopContext()), path);
  if (res.status >= 400) throw new ApiError(res.body as Problem);
  return res.body as T;
}

/** The store at this address, or null when there is none. Cached for the request. */
export const getStore = cache(async (): Promise<Store | null> => {
  try {
    return await apiGet<Store>('/resolve');
  } catch (err) {
    if (err instanceof ApiError && err.problem.status === 404) return null;
    throw err;
  }
});
