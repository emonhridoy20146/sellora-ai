import { SmsError } from '../sms.types.js';

export interface SmsCall {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  /** JSON body. */
  json?: unknown;
  /** Form body (application/x-www-form-urlencoded). */
  form?: Record<string, string>;
  /** The call sends a message: a lost answer means it may have been sent. */
  sends?: boolean;
}

export interface SmsReply {
  status: number;
  body: unknown;
}

const MAX_MESSAGE = 300;

/** The low-level reason behind a fetch failure (an error's code or message). */
function causeText(cause: unknown): string {
  if (cause instanceof Error) return `${(cause as { code?: string }).code ?? ''} ${cause.message}`;
  return asText(cause);
}

/** A value from a provider's answer as text: words and numbers as they are, anything else empty. */
export function asText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/** A provider's own words, flattened and shortened, for staff to read. */
export function shortText(value: unknown): string {
  const text = asText(value).replace(/\s+/g, ' ').trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

/**
 * HTTP for SMS adapters, with a timeout and failures sorted into SmsError kinds. Credentials
 * are passed by the adapter in the URL, body or headers as each provider requires, and never
 * copied into error messages.
 */
export class SmsHttp {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly provider: string,
    private readonly timeoutMs: number,
  ) {}

  async send(call: SmsCall): Promise<SmsReply> {
    const lost = (why: string) =>
      call.sends
        ? new SmsError('uncertain', `${why}. ${this.provider} may or may not have sent it.`)
        : new SmsError('unavailable', `${why}. Try again in a few minutes.`);

    let res: Response;
    try {
      res = await this.fetchFn(call.url, {
        method: call.method,
        headers: {
          accept: 'application/json',
          ...(call.json !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(call.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...call.headers,
        },
        ...(call.json !== undefined ? { body: JSON.stringify(call.json) } : {}),
        ...(call.form ? { body: new URLSearchParams(call.form).toString() } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      // A connection that was never made cannot have sent anything.
      const refused =
        err instanceof Error &&
        /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(causeText((err as { cause?: unknown }).cause));
      if (refused)
        throw new SmsError(
          'unavailable',
          `${this.provider} could not be reached. Try again later.`,
        );
      throw lost(
        timedOut ? `${this.provider} did not answer in time` : `${this.provider} is unreachable`,
      );
    }
    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // Some providers answer in plain text; adapters read it as such.
    }
    if (res.status === 429) throw new SmsError('busy', `${this.provider} is busy. Try again soon.`);
    // 503 says the provider turned the request away before doing anything; other 5xx answers
    // may come after the provider sent the message.
    if (res.status === 503)
      throw new SmsError('unavailable', `${this.provider} is down for now. Try again later.`);
    if (res.status >= 500) throw lost(`${this.provider} had a problem (HTTP ${res.status})`);
    return { status: res.status, body };
  }
}

/** A field of a JSON object answer, or undefined. */
export function field(body: unknown, key: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
}
