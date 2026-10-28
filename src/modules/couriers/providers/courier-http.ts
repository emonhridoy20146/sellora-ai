import { CourierError } from '../courier.types.js';

export interface CourierCall {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * A call that creates something (a booking). When its answer is lost the outcome is
   * unknown, which callers must not treat as a plain failure.
   */
  creates?: boolean;
}

export interface CourierReply {
  status: number;
  body: unknown;
}

const MAX_MESSAGE = 300;

/** The courier's own explanation from an error body, flattened and shortened. */
export function courierMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const parts: string[] = [];
  const errors = b.errors;
  if (errors && typeof errors === 'object') {
    for (const [field, value] of Object.entries(errors as Record<string, unknown>)) {
      const msgs = Array.isArray(value) ? value : [value];
      for (const m of msgs)
        if (typeof m === 'string') parts.push(/\s/.test(m) ? m : `${field}: ${m}`);
    }
  }
  if (!parts.length) {
    const candidates = [
      b.message,
      b.error,
      (b.error as Record<string, unknown> | undefined)?.message,
      b.msg,
    ];
    const first = candidates.find((c): c is string => typeof c === 'string' && c.length > 0);
    if (first) parts.push(first);
  }
  if (!parts.length) return null;
  const text = parts.join('; ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

/**
 * JSON over HTTP for courier adapters, with a timeout and failures sorted into
 * CourierError kinds. Credentials go in headers only and never into error messages.
 */
export class CourierHttp {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly courier: string,
    private readonly timeoutMs: number,
  ) {}

  async send(call: CourierCall): Promise<CourierReply> {
    const lost = (why: string) =>
      call.creates
        ? new CourierError(
            'uncertain',
            `${why}. ${this.courier} may or may not have made the booking.`,
          )
        : new CourierError('unavailable', `${why}. Try again in a few minutes.`);

    let res: Response;
    try {
      res = await this.fetchFn(call.url, {
        method: call.method,
        headers: {
          accept: 'application/json',
          ...(call.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...call.headers,
        },
        ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const timeout = err instanceof Error && err.name === 'TimeoutError';
      throw lost(
        timeout ? `${this.courier} did not answer in time` : `Could not reach ${this.courier}`,
      );
    }

    const text = await res.text().catch(() => '');
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    const said = courierMessage(body);

    if (res.status === 401 || res.status === 403)
      throw new CourierError(
        'auth',
        `${this.courier} did not accept the API credentials${said ? `: ${said}` : '.'}`,
        res.status,
      );
    if (res.status === 429)
      throw new CourierError(
        'busy',
        `${this.courier} is limiting requests right now. Try again in a minute.`,
        res.status,
      );
    if (res.status >= 500) throw lost(`${this.courier} had an error (${res.status})`);
    if (res.status >= 400)
      throw new CourierError(
        'rejected',
        said ? `${this.courier}: ${said}` : `${this.courier} refused the request (${res.status}).`,
        res.status,
      );
    if (body === null || typeof body !== 'object')
      throw lost(`${this.courier} sent an answer Sellora could not read`);
    return { status: res.status, body };
  }
}

/** Reads a nested value without trusting the shape. */
export function pick(value: unknown, ...path: (string | number)[]): unknown {
  let cur = value;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** A string or number id as a string; undefined for anything else. */
export function idString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Taka (a number or numeric string) to paisa; undefined when it is not a number. */
export function takaToMinor(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

/** Every string or number found under `keys` anywhere in a small JSON body. */
export function collectIds(body: unknown, keys: readonly string[], depth = 0): string[] {
  if (depth > 4 || body === null || typeof body !== 'object') return [];
  const out: string[] = [];
  const entries = Array.isArray(body)
    ? body.map((v, i) => [String(i), v] as const)
    : Object.entries(body as Record<string, unknown>);
  for (const [k, v] of entries.slice(0, 200)) {
    if (keys.includes(k)) {
      const id = idString(v);
      if (id && id.length <= 64) out.push(id);
    } else if (v && typeof v === 'object') out.push(...collectIds(v, keys, depth + 1));
  }
  return [...new Set(out)];
}
