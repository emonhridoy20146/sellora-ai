import { Inject, Injectable } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { AppConfig } from '../../config/app-config.js';

/** Injection token for the fetch the Google client uses, so tests can play Google's part. */
export const GOOGLE_FETCH = Symbol('GOOGLE_FETCH');

/** Only files Sellora creates: never the rest of the merchant's Drive. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';

/**
 * How a Google call failed. `revoked`: the merchant removed Sellora's access, or the refresh
 * token expired (`invalid_grant`); only connecting again helps. `quota`: the Drive is full or
 * Google is limiting calls. `other`: anything else (tried again later).
 */
export class GoogleError extends Error {
  constructor(
    readonly kind: 'revoked' | 'quota' | 'other',
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'GoogleError';
  }
}

export interface DriveFile {
  id: string;
  name: string;
  size: number;
  createdTime: string;
}

/** Google OAuth 2.0 and the Drive API, as far as backups need them (ADR 0021). */
@Injectable()
export class GoogleDriveClient {
  constructor(
    private readonly config: AppConfig,
    @Inject(GOOGLE_FETCH) private readonly fetch: typeof globalThis.fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.get('GOOGLE_OAUTH_CLIENT_ID'));
  }

  get redirectUri(): string {
    return `${this.config.get('API_PUBLIC_URL').replace(/\/+$/, '')}/v1/backups/google/callback`;
  }

  private get api(): string {
    return this.config.get('GOOGLE_API_URL').replace(/\/+$/, '');
  }

  /** Google's consent page, asking only for Drive files Sellora creates. */
  consentUrl(state: string, loginHint?: string): string {
    const u = new URL(this.config.get('GOOGLE_OAUTH_AUTH_URL'));
    u.searchParams.set('client_id', this.config.get('GOOGLE_OAUTH_CLIENT_ID')!);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', DRIVE_SCOPE);
    u.searchParams.set('access_type', 'offline');
    // Ask again each time, so Google always hands over a refresh token.
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
        throw new GoogleError(
          'revoked',
          'Google says the access was removed or has expired',
          res.status,
        );
      throw new GoogleError(
        'other',
        `Google refused the sign-in (${typeof json.error === 'string' ? json.error : res.status})`,
        res.status,
      );
    }
    return json;
  }

  /** Exchanges the code from the consent page for a refresh token and an access token. */
  async exchange(
    code: string,
  ): Promise<{ refreshToken: string; accessToken: string; scope: string }> {
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
      scope: typeof json.scope === 'string' ? json.scope : '',
    };
  }

  async accessToken(refreshToken: string): Promise<string> {
    const json = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (typeof json.access_token !== 'string')
      throw new GoogleError('other', 'Google gave no access token');
    return json.access_token;
  }

  /** Revokes the access at Google. Best effort: a token already revoked is fine. */
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
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      throw new GoogleError('other', 'Google Drive could not be reached');
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw driveError(res.status, json);
    return json as T;
  }

  /** The Google account's email (Drive's about, which the drive.file scope can read). */
  async email(token: string): Promise<string> {
    const about = await this.call<{ user?: { emailAddress?: string } }>(
      token,
      '/drive/v3/about?fields=user(emailAddress)',
    );
    return about.user?.emailAddress ?? '';
  }

  async createFolder(token: string, name: string): Promise<{ id: string; name: string }> {
    return this.call(token, '/drive/v3/files?fields=id,name', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER }),
    });
  }

  /** Whether the folder is still there (the merchant may have deleted it). */
  async folderExists(token: string, id: string): Promise<boolean> {
    try {
      const f = await this.call<{ trashed?: boolean }>(
        token,
        `/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed`,
      );
      return !f.trashed;
    } catch (err) {
      if (err instanceof GoogleError && err.status === 404) return false;
      throw err;
    }
  }

  /**
   * Uploads a file into the folder with a resumable upload (one request for the bytes).
   * Returns the file Google stored; its size is checked against the file's.
   */
  async upload(
    token: string,
    p: { folderId: string; name: string; path: string; size: number; contentType: string },
  ): Promise<DriveFile> {
    let start: Response;
    try {
      start = await this.fetch(
        `${this.api}/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,createdTime`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json; charset=UTF-8',
            'x-upload-content-type': p.contentType,
            'x-upload-content-length': String(p.size),
          },
          body: JSON.stringify({ name: p.name, parents: [p.folderId] }),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new GoogleError('other', 'Google Drive could not be reached');
    }
    if (!start.ok)
      throw driveError(
        start.status,
        (await start.json().catch(() => ({}))) as Record<string, unknown>,
      );
    const location = start.headers.get('location');
    if (!location) throw new GoogleError('other', 'Google Drive gave no upload address');
    let res: Response;
    try {
      res = await this.fetch(location, {
        method: 'PUT',
        headers: { 'content-type': p.contentType, 'content-length': String(p.size) },
        body: Readable.toWeb(createReadStream(p.path)) as unknown as ReadableStream,
        // Node's fetch needs this for a streamed body.
        ...({ duplex: 'half' } as Record<string, unknown>),
        signal: AbortSignal.timeout(30 * 60_000),
      });
    } catch {
      throw new GoogleError('other', 'The upload to Google Drive was cut off');
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw driveError(res.status, json);
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    const file = {
      id: text(json.id),
      name: text(json.name),
      size: Number(json.size),
      createdTime: text(json.createdTime),
    };
    if (!file.id) throw new GoogleError('other', 'Google Drive did not say which file it stored');
    if (file.size !== p.size)
      throw new GoogleError('other', `Google Drive stored ${file.size} bytes of ${p.size}`);
    return file;
  }

  /** Files in the folder, newest first. */
  async list(token: string, folderId: string): Promise<DriveFile[]> {
    const q = encodeURIComponent(
      `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
    );
    const res = await this.call<{
      files?: { id: string; name: string; size?: string; createdTime: string }[];
    }>(
      token,
      `/drive/v3/files?q=${q}&orderBy=createdTime%20desc&pageSize=100&fields=files(id,name,size,createdTime)`,
    );
    return (res.files ?? []).map((f) => ({ ...f, size: Number(f.size ?? 0) }));
  }

  async remove(token: string, id: string): Promise<void> {
    await this.call(token, `/drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

function driveError(status: number, json: Record<string, unknown>): GoogleError {
  const e = (json.error ?? {}) as { message?: string; errors?: { reason?: string }[] };
  const reason = e.errors?.[0]?.reason ?? '';
  if (status === 401)
    return new GoogleError('revoked', 'Google Drive no longer accepts Sellora', status);
  if (/storageQuotaExceeded|quotaExceeded/.test(reason))
    return new GoogleError('quota', 'The Google Drive is full', status);
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded/.test(reason))
    return new GoogleError('quota', 'Google Drive is limiting uploads; trying again later', status);
  return new GoogleError(
    'other',
    `Google Drive answered ${status}${e.message ? `: ${e.message}` : ''}`,
    status,
  );
}
