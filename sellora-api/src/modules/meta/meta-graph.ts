import { createHmac } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';

/** Injection token for the fetch the Graph client uses, so tests can play Meta's part. */
export const META_FETCH = Symbol('META_FETCH');

const DEFAULT_BASE_URL = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/**
 * Hosts Meta serves customers' media from: the Facebook and Instagram CDNs and WhatsApp's
 * media store. Media links arrive in webhooks, so downloads are refused anywhere else.
 */
const MEDIA_HOSTS = ['fbcdn.net', 'fbsbx.com', 'cdninstagram.com', 'facebook.com', 'whatsapp.net'];

/**
 * Graph API error codes this app reacts to (developers.facebook.com/docs/graph-api/guides/error-handling).
 * Meta labels most errors "OAuthException", rate limits and bad parameters included, so the
 * type says nothing; only the code does. Auth means the token or the app's permission is
 * gone: 190 (invalid or expired token), 102 (session), 10 and 200-299 (permission).
 */
const AUTH_CODES = new Set([102, 190, 10]);
const isPermissionCode = (code: number) => code >= 200 && code <= 299;
const RATE_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056]);
const TRANSIENT_CODES = new Set([1, 2, 131000, 131016]);
/** Outside the 24-hour window: Messenger 10/2018278 and 551/1545041, WhatsApp 131047. */
const WINDOW_CODES = new Set([131047]);
const WINDOW_SUBCODES = new Set([2018278, 2018108, 1545041]);

export type MetaErrorKind =
  | 'auth'
  | 'rate_limited'
  | 'outside_window'
  | 'transient'
  | 'network'
  | 'bad_request'
  | 'not_configured';

/** A failed Graph API call, classified by Meta's error code (never by message text). */
export class MetaGraphError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: MetaErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = 'MetaGraphError';
    this.retryable = kind === 'rate_limited' || kind === 'transient' || kind === 'network';
  }
}

/** Media that cannot be fetched, now or later: retrying would not help. */
export class MetaMediaError extends Error {
  constructor(
    readonly reason: 'too_large' | 'unavailable' | 'host_not_allowed',
    message: string,
  ) {
    super(message);
    this.name = 'MetaMediaError';
  }
}

interface GraphErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
  };
}

/** Classifies a Graph API error response. */
export function classifyGraphError(status: number, body: GraphErrorBody): MetaGraphError {
  const e = body.error ?? {};
  const code = typeof e.code === 'number' ? e.code : undefined;
  const subcode = typeof e.error_subcode === 'number' ? e.error_subcode : undefined;
  const message = e.message ?? `Graph API answered ${status}`;
  let kind: MetaErrorKind;
  if ((code !== undefined && WINDOW_CODES.has(code)) || (subcode && WINDOW_SUBCODES.has(subcode)))
    kind = 'outside_window';
  else if (code !== undefined && (AUTH_CODES.has(code) || isPermissionCode(code))) kind = 'auth';
  else if (code !== undefined && RATE_CODES.has(code)) kind = 'rate_limited';
  else if (e.is_transient || (code !== undefined && TRANSIENT_CODES.has(code)) || status >= 500)
    kind = 'transient';
  else kind = 'bad_request';
  return new MetaGraphError(kind, message, status, code, subcode);
}

/**
 * A small Graph API client. Every call with a token carries `appsecret_proof`, so a leaked
 * token is useless without the app secret. The API version and base URL come from the
 * environment; nothing here knows about a particular page or business.
 */
@Injectable()
export class MetaGraph {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: AppConfig,
    @Optional() @Inject(META_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  configured(): boolean {
    return Boolean(this.config.get('META_APP_ID') && this.config.get('META_APP_SECRET'));
  }

  appId(): string {
    const id = this.config.get('META_APP_ID');
    if (!id) throw new MetaGraphError('not_configured', 'META_APP_ID is not set');
    return id;
  }

  private appSecret(): string {
    const secret = this.config.get('META_APP_SECRET');
    if (!secret) throw new MetaGraphError('not_configured', 'META_APP_SECRET is not set');
    return secret;
  }

  version(): string {
    return this.config.get('META_GRAPH_VERSION');
  }

  /** The Facebook Login dialog lives on www.facebook.com, not the Graph host. */
  dialogUrl(path: string): string {
    return `https://www.facebook.com/${this.version()}/${path}`;
  }

  private url(path: string, query: Record<string, string>): string {
    const base = (this.config.get('META_GRAPH_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const qs = new URLSearchParams(query).toString();
    return `${base}/${this.version()}/${path.replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
  }

  /** HMAC-SHA256 of the token with the app secret, as Meta's "Require App Secret" expects. */
  proof(token: string): string {
    return createHmac('sha256', this.appSecret()).update(token).digest('hex');
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { token?: string; query?: Record<string, string>; body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    const query = { ...(opts.query ?? {}) };
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.token) {
      headers.authorization = `Bearer ${opts.token}`;
      query.appsecret_proof = this.proof(opts.token);
    }
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, query), {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new MetaGraphError(
        'network',
        `Could not reach Meta: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!res.ok) throw classifyGraphError(res.status, body as GraphErrorBody);
    return body as T;
  }

  get<T>(
    path: string,
    token: string,
    query: Record<string, string> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    return this.call<T>('GET', path, { token, query, ...opts });
  }

  post<T>(
    path: string,
    token: string,
    body: unknown,
    query: Record<string, string> = {},
  ): Promise<T> {
    return this.call<T>('POST', path, { token, query, body });
  }

  delete<T>(path: string, token: string, query: Record<string, string> = {}): Promise<T> {
    return this.call<T>('DELETE', path, { token, query });
  }

  /** Whether a media link points at Meta (or at the configured Graph API, for local stand-ins). */
  isMediaUrl(raw: string): boolean {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    const base = this.config.get('META_GRAPH_BASE_URL');
    if (base && url.origin === new URL(base).origin) return true;
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return MEDIA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  }

  /**
   * Downloads a customer's photo or file from Meta. WhatsApp's media store needs the
   * channel's token; the CDN links of Messenger and Instagram do not. Reads at most
   * `maxBytes`. Throws MetaMediaError when retrying cannot help, MetaGraphError otherwise.
   */
  async download(
    url: string,
    opts: { token?: string; maxBytes: number; timeoutMs?: number },
  ): Promise<{ bytes: Buffer; contentType: string | null }> {
    if (!this.isMediaUrl(url))
      throw new MetaMediaError('host_not_allowed', 'The media link does not point at Meta');
    const tooLarge = () =>
      new MetaMediaError(
        'too_large',
        `The file is larger than ${Math.round(opts.maxBytes / 1024 / 1024)} MB`,
      );
    const signal = AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
    let res: Response;
    let next = url;
    for (let hop = 0; ; hop++) {
      try {
        res = await this.fetchImpl(next, {
          method: 'GET',
          // The token goes to the link Meta gave, never to where it redirects.
          headers: opts.token && hop === 0 ? { authorization: `Bearer ${opts.token}` } : {},
          redirect: 'manual',
          signal,
        });
      } catch (err) {
        throw new MetaGraphError(
          'network',
          `Could not download from Meta: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      await res.body?.cancel();
      next = new URL(location, next).toString();
      // Every hop must stay on Meta's hosts.
      if (hop >= 3 || !this.isMediaUrl(next))
        throw new MetaMediaError('host_not_allowed', 'The media link redirects away from Meta');
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401)
        throw new MetaGraphError('auth', 'Meta refused the media download', 401);
      if (res.status === 429)
        throw new MetaGraphError('rate_limited', 'Meta rate-limited the media download', 429);
      if (res.status >= 500)
        throw new MetaGraphError('transient', `Meta answered ${res.status}`, res.status);
      // Expired CDN links answer 403; deleted media 404 or 410.
      throw new MetaMediaError('unavailable', `Meta answered ${res.status}: the media is gone`);
    }
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await res.body?.cancel();
      throw tooLarge();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body)
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > opts.maxBytes) {
          await res.body.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(Buffer.from(chunk));
      }
    return {
      bytes: Buffer.concat(chunks),
      contentType: res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null,
    };
  }

  /** The app id when the platform's Meta app is set up, else null. */
  appIdOrNull(): string | null {
    return this.config.get('META_APP_ID') ?? null;
  }

  // ------------------------------------------------------------------ OAuth

  /**
   * Exchanges a WhatsApp Embedded Signup code for the business integration token (already
   * long-lived; the popup flow has no redirect URI).
   */
  async businessTokenFromCode(code: string): Promise<string> {
    const res = await this.call<{ access_token?: string }>('GET', 'oauth/access_token', {
      query: { client_id: this.appId(), client_secret: this.appSecret(), code },
    });
    if (!res.access_token) throw new MetaGraphError('bad_request', 'Meta returned no token');
    return res.access_token;
  }

  /** Exchanges the login dialog's code for a user token, then for a long-lived one. */
  async userTokenFromCode(code: string, redirectUri: string): Promise<string> {
    const short = await this.call<{ access_token?: string }>('GET', 'oauth/access_token', {
      query: {
        client_id: this.appId(),
        client_secret: this.appSecret(),
        redirect_uri: redirectUri,
        code,
      },
    });
    if (!short.access_token) throw new MetaGraphError('bad_request', 'Meta returned no token');
    const long = await this.call<{ access_token?: string }>('GET', 'oauth/access_token', {
      query: {
        grant_type: 'fb_exchange_token',
        client_id: this.appId(),
        client_secret: this.appSecret(),
        fb_exchange_token: short.access_token,
      },
    });
    return long.access_token ?? short.access_token;
  }
}
