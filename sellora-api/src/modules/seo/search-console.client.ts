import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { GOOGLE_FETCH, GoogleError } from '../backups/google-drive.js';

/** Search Console data, adding the shop's site and submitting its sitemap. */
export const WEBMASTERS_SCOPE = 'https://www.googleapis.com/auth/webmasters';
/** Getting a verification token and proving the shop owns its address. */
export const SITE_VERIFICATION_SCOPE = 'https://www.googleapis.com/auth/siteverification';
export const SEO_GOOGLE_SCOPES = ['openid', 'email', WEBMASTERS_SCOPE, SITE_VERIFICATION_SCOPE];

export interface SearchRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

/** Owners and full users can read data and submit sitemaps. */
export function canUseSite(level: string): boolean {
  return level === 'siteOwner' || level === 'siteFullUser';
}

/** The `content` of the meta tag Google hands out (it may send the whole tag or only the value). */
export function metaContent(token: string): string {
  const m = /content\s*=\s*"([^"]+)"/i.exec(token) ?? /content\s*=\s*'([^']+)'/i.exec(token);
  return (m?.[1] ?? token).trim();
}

/** The email in the ID token Google returns with the `openid email` scopes. */
export function idTokenEmail(idToken: unknown): string {
  if (typeof idToken !== 'string') return '';
  const part = idToken.split('.')[1];
  if (!part) return '';
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email : '';
  } catch {
    return '';
  }
}

/**
 * Google OAuth 2.0, the Search Console API and the Site Verification API, as far as the SEO
 * studio needs them (ADR 0032). Uses the same OAuth client as Google Drive backups.
 */
@Injectable()
export class SearchConsoleClient {
  constructor(
    private readonly config: AppConfig,
    @Inject(GOOGLE_FETCH) private readonly fetch: typeof globalThis.fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.get('GOOGLE_OAUTH_CLIENT_ID'));
  }

  get redirectUri(): string {
    return `${this.config.get('API_PUBLIC_URL').replace(/\/+$/, '')}/v1/seo/google/callback`;
  }

  private get api(): string {
    return this.config.get('GOOGLE_API_URL').replace(/\/+$/, '');
  }

  consentUrl(state: string, loginHint?: string): string {
    const u = new URL(this.config.get('GOOGLE_OAUTH_AUTH_URL'));
    u.searchParams.set('client_id', this.config.get('GOOGLE_OAUTH_CLIENT_ID')!);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SEO_GOOGLE_SCOPES.join(' '));
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'false');
    u.searchParams.set('state', state);
    if (loginHint) u.searchParams.set('login_hint', loginHint);
    return u.toString();
  }

  private async token(body: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetch(this.config.get('GOOGLE_OAUTH_TOKEN_URL'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.get('GOOGLE_OAUTH_CLIENT_ID')!,
          client_secret: this.config.get('GOOGLE_OAUTH_CLIENT_SECRET')!,
          ...body,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GoogleError('other', 'Google could not be reached');
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (json.error === 'invalid_grant')
        throw new GoogleError('revoked', 'Google says the access was removed or has expired', 400);
      throw new GoogleError(
        'other',
        `Google refused the sign-in (${typeof json.error === 'string' ? json.error : res.status})`,
        res.status,
      );
    }
    return json;
  }

  async exchange(
    code: string,
  ): Promise<{ refreshToken: string; accessToken: string; scopes: string[]; email: string }> {
    const json = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });
    if (typeof json.refresh_token !== 'string' || typeof json.access_token !== 'string')
      throw new GoogleError('other', 'Google did not give long-term access. Try connecting again.');
    return {
      refreshToken: json.refresh_token,
      accessToken: json.access_token,
      scopes: typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : [],
      email: idTokenEmail(json.id_token),
    };
  }

  async accessToken(refreshToken: string): Promise<string> {
    const json = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (typeof json.access_token !== 'string')
      throw new GoogleError('other', 'Google gave no access token');
    return json.access_token;
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.fetch(this.config.get('GOOGLE_OAUTH_REVOKE_URL'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }

  private async call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.api}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      throw new GoogleError('other', 'Google could not be reached');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    if (!res.ok) throw googleApiError(res.status, json);
    return json as T;
  }

  private site(siteUrl: string): string {
    return encodeURIComponent(siteUrl);
  }

  /** Sites the Google account can see in Search Console. */
  async sites(token: string): Promise<SiteEntry[]> {
    const res = await this.call<{ siteEntry?: SiteEntry[] }>(token, '/webmasters/v3/sites');
    return res.siteEntry ?? [];
  }

  /** The value for `<meta name="google-site-verification">` on the site's home page. */
  async verificationToken(token: string, siteUrl: string): Promise<string> {
    const res = await this.call<{ token?: string }>(token, '/siteVerification/v1/token', {
      method: 'POST',
      body: JSON.stringify({
        site: { type: 'SITE', identifier: siteUrl },
        verificationMethod: 'META',
      }),
    });
    if (!res.token) throw new GoogleError('other', 'Google gave no verification token');
    return metaContent(res.token);
  }

  /** Asks Google to read the meta tag now and make the account an owner of the site. */
  async verify(token: string, siteUrl: string): Promise<void> {
    await this.call(token, '/siteVerification/v1/webResource?verificationMethod=META', {
      method: 'POST',
      body: JSON.stringify({ site: { type: 'SITE', identifier: siteUrl } }),
    });
  }

  async addSite(token: string, siteUrl: string): Promise<void> {
    await this.call(token, `/webmasters/v3/sites/${this.site(siteUrl)}`, { method: 'PUT' });
  }

  async submitSitemap(token: string, siteUrl: string, sitemapUrl: string): Promise<void> {
    await this.call(
      token,
      `/webmasters/v3/sites/${this.site(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
      { method: 'PUT' },
    );
  }

  /** Search performance rows (web search), up to 25,000 per call. */
  async query(
    token: string,
    siteUrl: string,
    q: { startDate: string; endDate: string; dimensions: string[]; rowLimit: number },
  ): Promise<SearchRow[]> {
    const res = await this.call<{ rows?: SearchRow[] }>(
      token,
      `/webmasters/v3/sites/${this.site(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        body: JSON.stringify({ ...q, type: 'web', dataState: 'all', startRow: 0 }),
      },
    );
    return res.rows ?? [];
  }
}

function googleApiError(status: number, json: Record<string, unknown>): GoogleError {
  const e = (json.error ?? {}) as { message?: string; errors?: { reason?: string }[] };
  const reason = e.errors?.[0]?.reason ?? '';
  if (status === 401) return new GoogleError('revoked', 'Google no longer accepts Sellora', status);
  if (status === 429 || /rateLimitExceeded|quotaExceeded/.test(reason))
    return new GoogleError('quota', 'Google is limiting requests; trying again later', status);
  return new GoogleError(
    'other',
    `Google answered ${status}${e.message ? `: ${e.message}` : ''}`,
    status,
  );
}
