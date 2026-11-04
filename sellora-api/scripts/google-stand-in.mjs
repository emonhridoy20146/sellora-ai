/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for Google's sign-in and Google Drive, for trying "Connect Google Drive" locally
 * (ADR 0021). It is NOT Google: it shows its own consent page with Allow and Deny, hands out
 * made-up codes and tokens, and keeps "Drive" files in memory. It speaks just enough of
 * OAuth 2.0 and the Drive v3 API for the backups client.
 *
 *   node scripts/google-stand-in.mjs     # on http://localhost:4060
 *
 * Point the API at it (.env), then restart the API and the worker:
 *
 *   GOOGLE_OAUTH_CLIENT_ID=stand-in-client
 *   GOOGLE_OAUTH_CLIENT_SECRET=stand-in-secret
 *   GOOGLE_OAUTH_AUTH_URL=http://localhost:4060/o/oauth2/v2/auth
 *   GOOGLE_OAUTH_TOKEN_URL=http://localhost:4060/token
 *   GOOGLE_OAUTH_REVOKE_URL=http://localhost:4060/revoke
 *   GOOGLE_API_URL=http://localhost:4060
 *
 *   open http://localhost:4060/drive            # the stand-in's "Drive": folders and files
 *   curl -X POST localhost:4060/__revoke-all    # as if the merchant removed Sellora's access
 *   curl -X POST localhost:4060/__full          # the next upload fails: "Drive is full"
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4060);
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? 'stand-in-client';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? 'stand-in-secret';
const EMAIL = process.env.STAND_IN_EMAIL ?? 'merchant@gmail.test';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const codes = new Map(); // code → { scope, email, redirectUri }
const refresh = new Map(); // refresh token → { email, revoked }
const access = new Map(); // access token → refresh token
const files = new Map(); // id → { id, name, mimeType, parents, bytes, createdTime }
const uploads = new Map(); // session id → { name, parents, mimeType }
let full = false;
const id = (p) => `${p}${randomBytes(9).toString('base64url')}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    ...headers,
  });
  res.end(text);
}

async function bodyOf(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function consentPage(q) {
  const scope = q.get('scope') ?? '';
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Google stand-in: sign in</title>
<style>body{font:16px system-ui;max-width:460px;margin:40px auto;padding:0 16px;color:#202124}
.card{border:1px solid #dadce0;border-radius:8px;padding:24px}.warn{background:#fef7e0;padding:8px 12px;border-radius:6px;font-size:14px}
button{font:inherit;padding:8px 20px;border-radius:4px;border:1px solid #dadce0;background:#fff;cursor:pointer;margin-right:8px}
button.allow{background:#1a73e8;color:#fff;border-color:#1a73e8}code{font-size:13px}</style>
<div class="card">
<p class="warn">This is a local stand-in, <b>not Google</b>. Nothing leaves this computer.</p>
<h1 style="font-size:22px">Sellora wants access to your Google Account</h1>
<p>Signed in as <b>${esc(q.get('login_hint') || EMAIL)}</b></p>
<p>Sellora will be able to:<br><b>See, edit, create and delete only the specific Google Drive files you use with this app</b></p>
<p><code>${esc(scope)}</code></p>
<form method="post" action="/o/oauth2/v2/decide">
${['client_id', 'redirect_uri', 'state', 'scope', 'login_hint'].map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) ?? '')}">`).join('')}
<button class="allow" name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button>
</form></div>`;
}

function drivePage() {
  const folders = [...files.values()].filter(
    (f) => f.mimeType === 'application/vnd.google-apps.folder',
  );
  const rows = folders
    .map((d) => {
      const inside = [...files.values()]
        .filter((f) => f.parents.includes(d.id))
        .sort((a, b) => b.createdTime.localeCompare(a.createdTime));
      return `<h2 style="font-size:18px">📁 ${esc(d.name)}</h2><ul>${
        inside
          .map(
            (f) =>
              `<li>${esc(f.name)} · ${f.bytes.length.toLocaleString()} bytes · ${esc(f.createdTime)}</li>`,
          )
          .join('') || '<li>(empty)</li>'
      }</ul>`;
    })
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>Google Drive stand-in</title>
<style>body{font:16px system-ui;max-width:760px;margin:32px auto;padding:0 16px}</style>
<p style="background:#fef7e0;padding:8px 12px;border-radius:6px">Local stand-in, <b>not Google Drive</b>. Files are kept in memory until it stops.</p>
<h1 style="font-size:22px">My Drive (${esc(EMAIL)})</h1>${rows || '<p>No folders yet.</p>'}`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/o/oauth2/v2/auth') {
      if (url.searchParams.get('client_id') !== CLIENT_ID)
        return send(res, 400, '<p>Unknown client_id</p>');
      return send(res, 200, consentPage(url.searchParams));
    }
    if (req.method === 'POST' && path === '/o/oauth2/v2/decide') {
      const f = new URLSearchParams((await bodyOf(req)).toString());
      const back = new URL(f.get('redirect_uri'));
      back.searchParams.set('state', f.get('state') ?? '');
      if (f.get('decision') === 'allow') {
        const code = id('c');
        codes.set(code, {
          scope: f.get('scope'),
          email: f.get('login_hint') || EMAIL,
          redirectUri: f.get('redirect_uri'),
        });
        back.searchParams.set('code', code);
        back.searchParams.set('scope', f.get('scope') ?? '');
      } else back.searchParams.set('error', 'access_denied');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && path === '/token') {
      const f = new URLSearchParams((await bodyOf(req)).toString());
      if (f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== CLIENT_SECRET)
        return send(res, 401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code'));
        codes.delete(f.get('code'));
        if (!c || c.redirectUri !== f.get('redirect_uri'))
          return send(res, 400, { error: 'invalid_grant' });
        const rt = id('rt-');
        const at = id('at-');
        refresh.set(rt, { email: c.email, revoked: false });
        access.set(at, rt);
        return send(res, 200, {
          access_token: at,
          refresh_token: rt,
          scope: c.scope,
          expires_in: 3599,
          token_type: 'Bearer',
        });
      }
      if (f.get('grant_type') === 'refresh_token') {
        const r = refresh.get(f.get('refresh_token'));
        if (!r || r.revoked)
          return send(res, 400, {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          });
        const at = id('at-');
        access.set(at, f.get('refresh_token'));
        return send(res, 200, {
          access_token: at,
          expires_in: 3599,
          scope: DRIVE_SCOPE,
          token_type: 'Bearer',
        });
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    if (req.method === 'POST' && path === '/revoke') {
      const token = new URLSearchParams((await bodyOf(req)).toString()).get('token');
      const r = refresh.get(token);
      if (r) r.revoked = true;
      return send(res, 200, {});
    }
    if (req.method === 'GET' && path === '/drive') return send(res, 200, drivePage());
    if (req.method === 'POST' && path === '/__revoke-all') {
      for (const r of refresh.values()) r.revoked = true;
      return send(res, 200, { revoked: refresh.size });
    }
    if (req.method === 'POST' && path === '/__full') {
      full = true;
      return send(res, 200, { full: true });
    }
    if (req.method === 'GET' && path === '/__files')
      return send(
        res,
        200,
        [...files.values()].map(({ bytes, ...f }) => ({ ...f, size: bytes.length })),
      );

    if (req.method === 'PUT' && path.startsWith('/upload-session/')) {
      const session = uploads.get(path.split('/').pop());
      if (!session) return send(res, 404, { error: { code: 404, message: 'No such upload' } });
      uploads.delete(path.split('/').pop());
      const bytes = await bodyOf(req);
      if (full) {
        full = false;
        return send(res, 403, {
          error: {
            code: 403,
            message: "The user's Drive storage quota has been exceeded.",
            errors: [{ reason: 'storageQuotaExceeded' }],
          },
        });
      }
      const f = { id: id('f'), ...session, bytes, createdTime: new Date().toISOString() };
      files.set(f.id, f);
      console.log(`stored ${f.name} (${bytes.length} bytes)`);
      return send(res, 200, {
        id: f.id,
        name: f.name,
        size: String(bytes.length),
        createdTime: f.createdTime,
      });
    }

    // The Drive API: the bearer token must be a live one.
    const rt = access.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!rt || refresh.get(rt)?.revoked)
      return send(res, 401, {
        error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] },
      });
    if (req.method === 'GET' && path === '/drive/v3/about')
      return send(res, 200, { user: { emailAddress: refresh.get(rt).email } });
    if (req.method === 'POST' && path === '/upload/drive/v3/files') {
      const meta = JSON.parse((await bodyOf(req)).toString());
      const sid = id('u');
      uploads.set(sid, {
        name: meta.name,
        parents: meta.parents ?? [],
        mimeType: req.headers['x-upload-content-type'] ?? 'application/octet-stream',
      });
      res.writeHead(200, { location: `http://localhost:${PORT}/upload-session/${sid}` });
      return res.end();
    }
    if (req.method === 'POST' && path === '/drive/v3/files') {
      const meta = JSON.parse((await bodyOf(req)).toString());
      const d = {
        id: id('d'),
        name: meta.name,
        mimeType: meta.mimeType,
        parents: ['root'],
        bytes: Buffer.alloc(0),
        createdTime: new Date().toISOString(),
      };
      files.set(d.id, d);
      return send(res, 200, { id: d.id, name: d.name });
    }
    if (req.method === 'GET' && path === '/drive/v3/files') {
      const m = /^'(.+)' in parents and trashed = false$/.exec(url.searchParams.get('q') ?? '');
      if (!m) return send(res, 400, { error: { code: 400, message: 'Invalid query' } });
      const list = [...files.values()]
        .filter((f) => f.parents.includes(m[1]))
        .sort((a, b) => b.createdTime.localeCompare(a.createdTime))
        .map((f) => ({
          id: f.id,
          name: f.name,
          size: String(f.bytes.length),
          createdTime: f.createdTime,
        }));
      return send(res, 200, { files: list });
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (one) {
      const f = files.get(decodeURIComponent(one[1]));
      if (!f)
        return send(res, 404, {
          error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] },
        });
      if (req.method === 'DELETE') {
        files.delete(f.id);
        res.writeHead(204);
        return res.end();
      }
      return send(res, 200, { id: f.id, trashed: false });
    }
    return send(res, 404, {
      error: { code: 404, message: `The stand-in has no ${req.method} ${path}` },
    });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: { code: 500, message: String(err) } });
  }
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`Google stand-in (NOT Google) on http://localhost:${PORT}; its Drive at /drive`),
);
