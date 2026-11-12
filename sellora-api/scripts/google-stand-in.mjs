/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for Google's sign-in, Google Drive, Search Console and Site Verification, for
 * trying "Connect Google Drive" (ADR 0021) and "Connect Search Console" (ADR 0032) locally.
 * It is NOT Google: it shows its own consent page with Allow and Deny, hands out made-up
 * codes and tokens, keeps "Drive" files in memory, and makes up Search Console numbers.
 * It speaks just enough of OAuth 2.0, Drive v3, Webmasters v3 and Site Verification v1.
 *
 * Site verification is real in one way: it fetches the store's home page and looks for the
 * google-site-verification meta tag, as Google does. Search numbers are invented (seeded
 * from the store's sitemap, so product pages show up); they are not anyone's real traffic.
 *
 *   node scripts/google-stand-in.mjs     # on http://localhost:4070
 *
 * Point the API at it (.env), then restart the API and the worker:
 *
 *   GOOGLE_OAUTH_CLIENT_ID=stand-in-client
 *   GOOGLE_OAUTH_CLIENT_SECRET=stand-in-secret
 *   GOOGLE_OAUTH_AUTH_URL=http://localhost:4070/o/oauth2/v2/auth
 *   GOOGLE_OAUTH_TOKEN_URL=http://localhost:4070/token
 *   GOOGLE_OAUTH_REVOKE_URL=http://localhost:4070/revoke
 *   GOOGLE_API_URL=http://localhost:4070
 *
 *   open http://localhost:4070/drive            # the stand-in's "Drive": folders and files
 *   curl -X POST localhost:4070/__revoke-all    # as if the merchant removed Sellora's access
 *   curl -X POST localhost:4070/__full          # the next upload fails: "Drive is full"
 *   open http://localhost:4070/search-console   # the stand-in's sites, owners and sitemaps
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const PORT = Number(process.env.PORT ?? 4070);
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? 'stand-in-client';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? 'stand-in-secret';
const EMAIL = process.env.STAND_IN_EMAIL ?? 'merchant@gmail.test';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const WEBMASTERS_SCOPE = 'https://www.googleapis.com/auth/webmasters';

const codes = new Map(); // code → { scope, email, redirectUri }
const refresh = new Map(); // refresh token → { email, revoked }
const access = new Map(); // access token → refresh token
const files = new Map(); // id → { id, name, mimeType, parents, bytes, createdTime }
const uploads = new Map(); // session id → { name, parents, mimeType }
let full = false;
/** Search Console: owners by site, verification tokens, sitemaps. */
const owners = new Map(); // siteUrl → Set(email)
const added = new Map(); // email → Set(siteUrl) (sites in the account's Search Console)
const verifyTokens = new Map(); // `${email} ${siteUrl}` → token
const sitemaps = new Map(); // siteUrl → [{ path, submitted, urls }]
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
<p>Sellora will be able to:</p><ul>${
    scope.includes('drive.file')
      ? '<li><b>See, edit, create and delete only the specific Google Drive files you use with this app</b></li>'
      : ''
  }${
    scope.includes('webmasters')
      ? '<li><b>View and manage Search Console data for your verified sites</b></li>'
      : ''
  }${
    scope.includes('siteverification')
      ? '<li><b>Manage the list of sites and domains you control</b></li>'
      : ''
  }${scope.includes('email') ? '<li>See your primary Google Account email address</li>' : ''}</ul>
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

/** The ID token Google returns with `openid email`, unsigned (only the email is read). */
function idToken(email) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ email, email_verified: true, iss: 'google-stand-in' })}.`;
}

function insufficient() {
  return {
    error: {
      code: 403,
      message: 'Request had insufficient authentication scopes.',
      errors: [{ reason: 'insufficientPermissions' }],
    },
  };
}

/** GETs a page; *.localhost names go to this computer (they are not in DNS here). */
function fetchText(address, redirects = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(address);
    const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost');
    const get = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const r = get(
      {
        host: local ? '127.0.0.1' : u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers: { host: u.host, 'user-agent': 'Mozilla/5.0 (compatible; Google-stand-in)' },
        timeout: 10_000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirects > 0
        ) {
          res.resume();
          return resolve(fetchText(new URL(res.headers.location, u).toString(), redirects - 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    r.on('timeout', () => r.destroy(new Error('timed out')));
    r.on('error', reject);
    r.end();
  });
}

/** A number from 0 to 1 that is always the same for the same text. */
function unit(text) {
  return createHash('sha256').update(text).digest().readUInt32BE(0) / 2 ** 32;
}

/** Search phrases for a page, made up from the words of its address. */
function phrasesFor(page) {
  const slug = decodeURIComponent(new URL(page).pathname.split('/').filter(Boolean).pop() ?? '');
  const words = slug.split('-').filter(Boolean).slice(0, 4).join(' ');
  if (!words) return ['online shop bangladesh', 'home delivery dhaka'];
  return [words, `${words} price`, `${words} price in bangladesh`, `buy ${words} online`];
}

/**
 * Made-up Search Console rows: per day for `date`, per phrase and page for `query,page`.
 * Pages come from the submitted sitemap, so the shop's own products appear. NOT real data.
 */
function searchRows(siteUrl, q) {
  const dims = (q.dimensions ?? []).join(',');
  const start = new Date(`${q.startDate}T00:00:00Z`);
  const end = new Date(`${q.endDate}T00:00:00Z`);
  const days = Math.max(1, Math.round((end - start) / 86_400_000) + 1);
  const pages = (sitemaps.get(siteUrl) ?? []).flatMap((s) => s.pages ?? []);
  const growth = (i) => 0.4 + (0.6 * i) / days; // the store gets found a bit more each day
  if (dims === 'date') {
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      const impressions = Math.round(
        (40 + pages.length * 6) * growth(i) * (0.7 + 0.6 * unit(`${siteUrl}${d}`)),
      );
      const clicks = Math.round(impressions * (0.02 + 0.05 * unit(`c${siteUrl}${d}`)));
      return {
        keys: [d],
        clicks,
        impressions,
        ctr: impressions ? clicks / impressions : 0,
        position: Math.round((6 + 10 * unit(`p${siteUrl}${d}`)) * 10) / 10,
      };
    });
  }
  if (dims === 'query,page') {
    const rows = [];
    for (const page of pages.length ? pages : [siteUrl]) {
      for (const query of phrasesFor(page)) {
        const u = unit(`${query} ${page}`);
        if (u < 0.15) continue;
        const position = Math.round((2 + 22 * unit(`pos ${query} ${page}`)) * 10) / 10;
        const impressions = Math.round((days / 28) * (20 + 400 * u * u));
        const expected = position < 4 ? 0.12 : position < 11 ? 0.04 : 0.008;
        const clicks = Math.round(
          impressions * expected * (0.2 + 1.2 * unit(`ctr ${query} ${page}`)),
        );
        rows.push({
          keys: [query, page],
          clicks,
          impressions,
          ctr: impressions ? clicks / impressions : 0,
          position,
        });
      }
    }
    return rows.sort((a, b) => b.impressions - a.impressions).slice(0, q.rowLimit ?? 1000);
  }
  return [];
}

function consolePage() {
  const all = new Set([...owners.keys(), ...[...added.values()].flatMap((s) => [...s])]);
  const rows = [...all]
    .map(
      (s) =>
        `<h2 style="font-size:18px">${esc(s)}</h2><p>Owners: ${esc([...(owners.get(s) ?? [])].join(', ') || 'none (not verified)')}</p><ul>${
          (sitemaps.get(s) ?? [])
            .map(
              (m) =>
                `<li>Sitemap ${esc(m.path)}: ${m.urls} addresses, sent ${esc(m.submitted)}</li>`,
            )
            .join('') || '<li>No sitemap sent</li>'
        }</ul>`,
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>Search Console stand-in</title>
<style>body{font:16px system-ui;max-width:760px;margin:32px auto;padding:0 16px}</style>
<p style="background:#fef7e0;padding:8px 12px;border-radius:6px">Local stand-in, <b>not Google Search Console</b>. Numbers it hands out are made up.</p>
<h1 style="font-size:22px">Sites</h1>${rows || '<p>No sites yet.</p>'}`;
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
        refresh.set(rt, { email: c.email, revoked: false, scope: c.scope ?? '' });
        access.set(at, rt);
        return send(res, 200, {
          access_token: at,
          refresh_token: rt,
          scope: c.scope,
          expires_in: 3599,
          token_type: 'Bearer',
          // An unsigned stand-in ID token: only its email claim is read.
          ...((c.scope ?? '').split(' ').includes('email') ? { id_token: idToken(c.email) } : {}),
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
          scope: r.scope || DRIVE_SCOPE,
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
    if (req.method === 'GET' && path === '/search-console') return send(res, 200, consolePage());
    if (req.method === 'GET' && path === '/__search-console')
      return send(res, 200, {
        owners: Object.fromEntries([...owners].map(([k, v]) => [k, [...v]])),
        sites: Object.fromEntries([...added].map(([k, v]) => [k, [...v]])),
        sitemaps: Object.fromEntries(sitemaps),
      });
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
    const email = refresh.get(rt).email;
    const scopes = (refresh.get(rt).scope ?? '').split(' ');
    if (path.startsWith('/webmasters/') && !scopes.includes(WEBMASTERS_SCOPE))
      return send(res, 403, insufficient());
    if (
      path.startsWith('/siteVerification/') &&
      !scopes.some((x) => x.endsWith('/siteverification'))
    )
      return send(res, 403, insufficient());

    // Site Verification v1: a META token, then a check of the live home page.
    if (req.method === 'POST' && path === '/siteVerification/v1/token') {
      const b = JSON.parse((await bodyOf(req)).toString());
      const site = b.site?.identifier;
      if (b.verificationMethod !== 'META' || !site)
        return send(res, 400, { error: { code: 400, message: 'Invalid request' } });
      const key = `${email} ${site}`;
      if (!verifyTokens.has(key))
        verifyTokens.set(key, createHash('sha256').update(key).digest('base64url').slice(0, 43));
      return send(res, 200, {
        method: 'META',
        token: `<meta name="google-site-verification" content="${verifyTokens.get(key)}" />`,
      });
    }
    if (req.method === 'POST' && path === '/siteVerification/v1/webResource') {
      const b = JSON.parse((await bodyOf(req)).toString());
      const site = b.site?.identifier;
      const token = verifyTokens.get(`${email} ${site}`);
      if (!site || !token)
        return send(res, 400, {
          error: { code: 400, message: 'No verification token was requested.' },
        });
      let html = '';
      try {
        html = (await fetchText(site)).body;
      } catch (err) {
        return send(res, 400, {
          error: {
            code: 400,
            message: `The site could not be reached: ${String(err.message ?? err)}`,
          },
        });
      }
      const found = [...html.matchAll(/<meta[^>]+>/gi)].some(
        (m) => /name="google-site-verification"/i.test(m[0]) && m[0].includes(`content="${token}"`),
      );
      if (!found)
        return send(res, 400, {
          error: {
            code: 400,
            message: 'The necessary verification token could not be found on your site.',
            errors: [{ reason: 'badRequest' }],
          },
        });
      if (!owners.has(site)) owners.set(site, new Set());
      owners.get(site).add(email);
      console.log(`verified ${site} for ${email}`);
      return send(res, 200, {
        id: encodeURIComponent(site),
        site: b.site,
        owners: [...owners.get(site)],
      });
    }

    // Webmasters v3 (Search Console).
    if (req.method === 'GET' && path === '/webmasters/v3/sites') {
      const mine = [...(added.get(email) ?? [])];
      return send(res, 200, {
        siteEntry: mine.map((siteUrl) => ({
          siteUrl,
          permissionLevel: owners.get(siteUrl)?.has(email) ? 'siteOwner' : 'siteUnverifiedUser',
        })),
      });
    }
    const site = /^\/webmasters\/v3\/sites\/([^/]+)(\/.*)?$/.exec(path);
    if (site) {
      const siteUrl = decodeURIComponent(site[1]);
      const rest = site[2] ?? '';
      if (req.method === 'PUT' && !rest) {
        if (!added.has(email)) added.set(email, new Set());
        added.get(email).add(siteUrl);
        res.writeHead(204);
        return res.end();
      }
      if (!owners.get(siteUrl)?.has(email))
        return send(res, 403, {
          error: {
            code: 403,
            message: `User does not have sufficient permission for site '${siteUrl}'.`,
            errors: [{ reason: 'forbidden' }],
          },
        });
      const sm = /^\/sitemaps\/([^/]+)$/.exec(rest);
      if (req.method === 'PUT' && sm) {
        const feed = decodeURIComponent(sm[1]);
        let urls = [];
        try {
          urls = [...(await fetchText(feed)).body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
            (m) => m[1],
          );
        } catch {
          urls = [];
        }
        const list = (sitemaps.get(siteUrl) ?? []).filter((x) => x.path !== feed);
        list.push({
          path: feed,
          submitted: new Date().toISOString(),
          urls: urls.length,
          pages: urls,
        });
        sitemaps.set(siteUrl, list);
        console.log(`sitemap ${feed}: ${urls.length} addresses`);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'POST' && rest === '/searchAnalytics/query') {
        const q = JSON.parse((await bodyOf(req)).toString());
        return send(res, 200, { rows: searchRows(siteUrl, q), responseAggregationType: 'byPage' });
      }
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
  console.log(
    `Google stand-in (NOT Google) on http://localhost:${PORT}; its Drive at /drive, Search Console at /search-console`,
  ),
);
