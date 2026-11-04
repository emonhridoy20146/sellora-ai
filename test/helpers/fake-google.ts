import { DRIVE_SCOPE } from '../../src/modules/backups/google-drive.js';

/** The Google URLs a test app points at (see `googleEnv`). */
export const GOOGLE_TEST = {
  auth: 'https://google.test/o/oauth2/v2/auth',
  token: 'https://google.test/token',
  revoke: 'https://google.test/revoke',
  api: 'https://google.test/api',
  clientId: 'test-client.apps.googleusercontent.com',
  clientSecret: 'test-client-secret',
};

export const googleEnv = {
  GOOGLE_OAUTH_CLIENT_ID: GOOGLE_TEST.clientId,
  GOOGLE_OAUTH_CLIENT_SECRET: GOOGLE_TEST.clientSecret,
  GOOGLE_OAUTH_AUTH_URL: GOOGLE_TEST.auth,
  GOOGLE_OAUTH_TOKEN_URL: GOOGLE_TEST.token,
  GOOGLE_OAUTH_REVOKE_URL: GOOGLE_TEST.revoke,
  GOOGLE_API_URL: GOOGLE_TEST.api,
};

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  bytes: Buffer;
  createdTime: string;
  trashed: boolean;
}

/**
 * Plays Google's part for the Drive client: OAuth codes and tokens, revocation, folders,
 * resumable uploads, listing and deleting files. In memory; one per test file.
 */
export class FakeGoogle {
  /** Codes the consent page "issued", with the scope granted and the account. */
  readonly codes = new Map<string, { scope: string; email: string }>();
  /** Refresh tokens and whether they still work. */
  readonly refresh = new Map<string, { email: string; revoked: boolean }>();
  readonly access = new Map<string, string>();
  readonly files = new Map<string, FakeFile>();
  readonly revoked: string[] = [];
  readonly calls: { method: string; url: string }[] = [];
  /** The next upload fails with this Drive answer. */
  failNextUpload: { status: number; reason: string; message: string } | null = null;
  private seq = 0;
  private uploads = new Map<string, { name: string; parents: string[]; mimeType: string }>();

  /** A code as Google's consent page would hand back to the callback. */
  issueCode(email = 'merchant@gmail.test', scope = DRIVE_SCOPE): string {
    const code = `code-${++this.seq}`;
    this.codes.set(code, { scope, email });
    return code;
  }

  /** As if the merchant removed Sellora in their Google account. */
  revokeAll(): void {
    for (const r of this.refresh.values()) r.revoked = true;
  }

  folder(id: string): FakeFile[] {
    return [...this.files.values()].filter((f) => f.parents.includes(id) && !f.trashed);
  }

  /** A file the merchant put in the folder themselves. */
  addOwnFile(folderId: string, name: string): FakeFile {
    const f: FakeFile = {
      id: `f${++this.seq}`,
      name,
      mimeType: 'text/plain',
      parents: [folderId],
      bytes: Buffer.from('my notes'),
      createdTime: new Date(Date.now() - 86_400_000).toISOString(),
      trashed: false,
    };
    this.files.set(f.id, f);
    return f;
  }

  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init.method ?? 'GET').toUpperCase();
    this.calls.push({ method, url: url.href });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
    const bodyText = () => (typeof init.body === 'string' ? init.body : '');
    const form = () => new URLSearchParams(bodyText());

    if (url.href === GOOGLE_TEST.token) {
      const f = form();
      if (
        f.get('client_id') !== GOOGLE_TEST.clientId ||
        f.get('client_secret') !== GOOGLE_TEST.clientSecret
      )
        return json(401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        const issued = this.codes.get(f.get('code') ?? '');
        if (!issued || !f.get('redirect_uri')?.endsWith('/v1/backups/google/callback'))
          return json(400, { error: 'invalid_grant' });
        this.codes.delete(f.get('code')!);
        const rt = `rt-${++this.seq}`;
        const at = `at-${++this.seq}`;
        this.refresh.set(rt, { email: issued.email, revoked: false });
        this.access.set(at, rt);
        return json(200, {
          access_token: at,
          refresh_token: rt,
          scope: issued.scope,
          expires_in: 3599,
          token_type: 'Bearer',
        });
      }
      if (f.get('grant_type') === 'refresh_token') {
        const rt = f.get('refresh_token') ?? '';
        const r = this.refresh.get(rt);
        if (!r || r.revoked)
          return json(400, {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          });
        const at = `at-${++this.seq}`;
        this.access.set(at, rt);
        return json(200, {
          access_token: at,
          expires_in: 3599,
          scope: DRIVE_SCOPE,
          token_type: 'Bearer',
        });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.href === GOOGLE_TEST.revoke) {
      const token = form().get('token') ?? '';
      const r = this.refresh.get(token);
      if (r) r.revoked = true;
      this.revoked.push(token);
      return new Response('', { status: 200 });
    }

    // Upload sessions: the address Google handed out.
    const session = this.uploads.get(url.href);
    if (session && method === 'PUT') {
      this.uploads.delete(url.href);
      const bytes = Buffer.from(await new Response(init.body as ReadableStream).arrayBuffer());
      if (this.failNextUpload) {
        const f = this.failNextUpload;
        this.failNextUpload = null;
        return json(f.status, {
          error: { code: f.status, message: f.message, errors: [{ reason: f.reason }] },
        });
      }
      const file: FakeFile = {
        id: `f${++this.seq}`,
        ...session,
        bytes,
        createdTime: new Date(Date.now() + this.seq).toISOString(),
        trashed: false,
      };
      this.files.set(file.id, file);
      return json(200, {
        id: file.id,
        name: file.name,
        size: String(bytes.length),
        createdTime: file.createdTime,
      });
    }

    if (!url.href.startsWith(GOOGLE_TEST.api)) return json(404, { error: 'not google' });
    const auth = new Headers(init.headers).get('authorization') ?? '';
    const rt = this.access.get(auth.replace(/^Bearer /, ''));
    if (!rt || this.refresh.get(rt)?.revoked)
      return json(401, {
        error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] },
      });
    const path = url.pathname.replace(/^\/api/, '');

    if (path === '/drive/v3/about')
      return json(200, { user: { emailAddress: this.refresh.get(rt)!.email } });
    if (
      path === '/upload/drive/v3/files' &&
      method === 'POST' &&
      url.searchParams.get('uploadType') === 'resumable'
    ) {
      const meta = JSON.parse(bodyText()) as { name: string; parents: string[] };
      const headers = new Headers(init.headers);
      const location = `https://google.test/upload-session/${++this.seq}`;
      this.uploads.set(location, {
        name: meta.name,
        parents: meta.parents,
        mimeType: headers.get('x-upload-content-type') ?? 'application/octet-stream',
      });
      return new Response('', { status: 200, headers: { location } });
    }
    if (path === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(bodyText()) as { name: string; mimeType: string };
      const folder: FakeFile = {
        id: `d${++this.seq}`,
        name: meta.name,
        mimeType: meta.mimeType,
        parents: ['root'],
        bytes: Buffer.alloc(0),
        createdTime: new Date().toISOString(),
        trashed: false,
      };
      this.files.set(folder.id, folder);
      return json(200, { id: folder.id, name: folder.name });
    }
    if (path === '/drive/v3/files' && method === 'GET') {
      const m = /^'(.+)' in parents and trashed = false$/.exec(url.searchParams.get('q') ?? '');
      if (!m) return json(400, { error: { code: 400, message: 'Invalid query' } });
      const files = this.folder(m[1]!.replace(/\\'/g, "'"))
        .sort((a, b) => b.createdTime.localeCompare(a.createdTime))
        .map((f) => ({
          id: f.id,
          name: f.name,
          size: String(f.bytes.length),
          createdTime: f.createdTime,
        }));
      return json(200, { files });
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (one) {
      const f = this.files.get(decodeURIComponent(one[1]!));
      if (!f)
        return json(404, {
          error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] },
        });
      if (method === 'DELETE') {
        this.files.delete(f.id);
        return new Response(null, { status: 204 });
      }
      return json(200, { id: f.id, trashed: f.trashed });
    }
    return json(404, { error: { code: 404, message: `No fake for ${method} ${path}` } });
  }) as typeof fetch;
}
