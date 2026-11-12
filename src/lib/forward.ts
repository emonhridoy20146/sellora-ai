import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { AB_COOKIE, validAbId } from './ab';
import { PREVIEW_COOKIE, callApi, contextFrom } from './api';
import { sameOrigin } from './request';

const MAX_BODY = 32 * 1024;

function problem(status: number, code: string, detail: string) {
  return NextResponse.json(
    { status, code, detail },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Passes a shopper's request from the browser to the storefront API, adding the
 * storefront key, the shop's host and the shopper's address. Only same-site JSON is
 * accepted: a JSON body cannot be sent from another site without a CORS preflight, which
 * this app never allows, so other sites cannot place orders in a shopper's name.
 */
export async function forward(
  req: NextRequest,
  path: string,
  opts: { allowPreview: boolean; idempotent?: boolean },
): Promise<NextResponse> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    return problem(415, 'unsupported_media_type', 'Send JSON.');
  if (!sameOrigin(req.headers.get('origin'), req.headers.get('host')))
    return problem(403, 'origin_not_allowed', 'Request origin is not allowed.');
  const text = await req.text();
  if (text.length > MAX_BODY) return problem(413, 'too_large', 'The request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return problem(400, 'invalid_json', 'The request is not valid JSON.');
  }
  const ctx = contextFrom(
    req.headers,
    opts.allowPreview ? req.cookies.get(PREVIEW_COOKIE)?.value : undefined,
    // A landing page's visit, order and coupon count for the version this browser sees.
    validAbId(req.cookies.get(AB_COOKIE)?.value),
  );
  const idempotencyKey = opts.idempotent ? req.headers.get('idempotency-key') : null;
  try {
    const res = await callApi(ctx, path, {
      method: 'POST',
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    const retry = (res.body as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
    if (res.status === 429 && typeof retry === 'number') headers['retry-after'] = String(retry);
    return NextResponse.json(res.body, { status: res.status, headers });
  } catch {
    return problem(502, 'shop_unreachable', 'The shop could not be reached. Try again.');
  }
}
