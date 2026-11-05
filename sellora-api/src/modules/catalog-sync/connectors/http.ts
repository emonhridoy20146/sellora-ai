import { setTimeout as sleep } from 'node:timers/promises';
import {
  SafeHttpError,
  type SafeRequest,
  type SafeResponse,
} from '../../../infra/http/safe-http.js';
import { SourceError, type ConnectorContext } from './connector.js';

const MB = 1024 * 1024;
/** API pages are small; a sheet may be larger. */
export const API_MAX_BYTES = 8 * MB;
/** Waits on "too many requests" before giving up for this run. */
const MAX_RATE_WAITS = 4;
const MAX_WAIT_MS = 10_000;

function retryAfterMs(res: SafeResponse, attempt: number): number {
  const header = res.headers['retry-after'];
  const seconds = header ? Number(header) : NaN;
  const ms = Number.isFinite(seconds) ? seconds * 1000 : 1000 * 2 ** attempt;
  return Math.min(Math.max(ms, 250), MAX_WAIT_MS);
}

/** A SafeHttpError in words for the merchant, as a SourceError. */
export function fromHttpError(err: unknown, what: string): SourceError {
  if (err instanceof SourceError) return err;
  if (err instanceof SafeHttpError)
    switch (err.reason) {
      case 'bad_url':
      case 'blocked_address':
        return new SourceError('bad_input', err.message);
      case 'dns':
        return new SourceError('not_found', `${what} could not be found. Check the address.`);
      case 'too_large':
        return new SourceError('too_large', `${what} sent more than Sellora can read at once.`);
      case 'timeout':
        return new SourceError('unavailable', `${what} took too long to answer.`);
      case 'too_many_redirects':
        return new SourceError('bad_input', `${what} redirected too many times.`);
      case 'network':
        return new SourceError('unavailable', `${what} could not be reached: ${err.message}`);
    }
  return new SourceError('unavailable', `${what} could not be reached.`);
}

/**
 * One request with the waits a shop's API asks for (429 with Retry-After), and status codes
 * turned into SourceErrors. Returns the response for 2xx only.
 */
export async function call(
  ctx: ConnectorContext,
  url: string,
  req: Omit<SafeRequest, 'maxBytes'> & { maxBytes?: number },
  what: string,
): Promise<SafeResponse> {
  for (let attempt = 0; ; attempt++) {
    let res: SafeResponse;
    try {
      res = await ctx.http.request(url, { maxBytes: API_MAX_BYTES, ...req });
    } catch (err) {
      throw fromHttpError(err, what);
    }
    if (res.status === 429 || res.status === 503) {
      if (attempt >= MAX_RATE_WAITS)
        throw new SourceError(
          'rate_limited',
          `${what} is busy (too many requests). Sellora will try again.`,
        );
      await sleep(retryAfterMs(res, attempt));
      continue;
    }
    if (res.status >= 200 && res.status < 300) return res;
    if (res.status === 401 || res.status === 403)
      throw new SourceError('auth', `${what} refused the key. Check it and its permissions.`);
    if (res.status === 404)
      throw new SourceError('not_found', `${what} was not found at this address.`);
    if (res.status === 402 || res.status === 423)
      throw new SourceError('auth', `${what} is closed or locked (HTTP ${res.status}).`);
    if (res.status >= 500)
      throw new SourceError('unavailable', `${what} had a problem (HTTP ${res.status}).`);
    throw new SourceError('bad_response', `${what} answered HTTP ${res.status}.`);
  }
}

export function parseJson<T>(res: SafeResponse, what: string): T {
  try {
    return res.json<T>();
  } catch {
    throw new SourceError('bad_response', `${what} did not answer with JSON. Check the address.`);
  }
}
