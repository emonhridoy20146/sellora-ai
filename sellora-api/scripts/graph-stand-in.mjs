/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for Meta's Graph API, for local demos and browser checks when no real Meta app
 * is available. It is NOT Meta: it knows two demo Facebook pages (one with an Instagram
 * account) and one WhatsApp number, accepts any login code, and records what Sellora sends.
 * Like Meta it insists on a bearer token with a matching appsecret_proof, so the client's
 * side of the contract is exercised for real.
 *
 *   META_APP_SECRET=... node scripts/graph-stand-in.mjs     # listens on 127.0.0.1:4020
 *   META_GRAPH_BASE_URL=http://127.0.0.1:4020 npm run dev   # and the same for dev:worker
 *
 * Test hooks (not part of the Graph API):
 *   GET  /__sent                 messages Sellora sent, oldest first
 *   POST /__fail {"code":613}    the next send answers with that Graph error code
 *   GET  /__photo/<name>.jpg     a demo product photo, standing in for a Messenger or
 *                                Instagram CDN link (`expired.jpg` answers 403 like an old link)
 *   GET  /__audio/<name>.mp4     a demo voice clip (MP4 audio, a tone with no speech), standing
 *                                in for a Messenger or Instagram voice clip link
 *
 * WhatsApp media: GET /<version>/wa-media-<anything> answers like Meta's media endpoint, with
 * a download link that needs the same token; `wa-voice-<anything>` is a voice note (Ogg Opus,
 * a tone with no speech).
 *
 * Never point a production deployment at it.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import sharp from 'sharp';

const fixture = (name) => readFileSync(new URL(`../test/fixtures/audio/${name}`, import.meta.url));
/** Demo recordings: tones, not speech (see test/fixtures/audio). */
const VOICE_OGG = fixture('voice-4s.ogg');
const VOICE_MP4 = fixture('voice-2s.m4a');

const PORT = Number(process.env.PORT ?? 4020);
const SECRET = process.env.META_APP_SECRET;
if (!SECRET) {
  console.error('Set META_APP_SECRET to the same value the API uses.');
  process.exit(1);
}

const PAGES = [
  {
    id: '100000000000001',
    name: 'Sellora Demo Page',
    access_token: 'stand-in-page-token-0001',
    tasks: ['MESSAGING', 'MANAGE'],
    instagram_business_account: { id: '17841400000000777', username: 'sellora.demo' },
  },
  {
    id: '100000000000002',
    name: 'Sellora Demo Outlet',
    access_token: 'stand-in-page-token-0002',
    tasks: ['MESSAGING', 'MANAGE'],
  },
];
const WHATSAPP = {
  phoneNumberId: '200000000000001',
  wabaId: '300000000000001',
  display_phone_number: '+880 1711-000000',
  verified_name: 'Sellora Demo',
};
const USER_TOKEN = 'stand-in-user-token';

/** Demo photo colours by name; anything else gets a colour from its name. */
const COLOURS = { 'red-saree': '#b3261e', 'blue-panjabi': '#1f4e8c', 'green-kurti': '#2e7d32' };
const photos = new Map();

/** A product-like demo photo: a coloured garment shape on a light background. */
async function demoPhoto(name) {
  if (photos.has(name)) return photos.get(name);
  const colour = COLOURS[name] ?? `#${createHash('sha256').update(name).digest('hex').slice(0, 6)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
    <rect width="100%" height="100%" fill="#f4efe6"/>
    <path d="M560 180 L700 120 Q800 200 900 120 L1040 180 L1180 420 L1060 480 L1020 400 L1020 1080 L580 1080 L580 400 L540 480 L420 420 Z" fill="${colour}"/>
    <g fill="#f5d36b" opacity="0.85">${Array.from({ length: 24 }, (_, i) => `<circle cx="${620 + (i % 6) * 72}" cy="${520 + Math.floor(i / 6) * 130}" r="16"/>`).join('')}</g>
    <text x="800" y="1150" font-family="sans-serif" font-size="40" text-anchor="middle" fill="#555">Stand-in photo: ${name}</text>
  </svg>`;
  const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
  photos.set(name, bytes);
  return bytes;
}

function sendPhoto(res, bytes) {
  res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(bytes.length) });
  res.end(bytes);
}

const sent = [];
let failNext = null;
let seq = 0;
/** Message ids stay unique across restarts, like Meta's. */
const boot = Date.now().toString(36);

const known = (token) =>
  token === `${USER_TOKEN}-long` ||
  PAGES.some((p) => p.access_token === token) ||
  token.startsWith('stand-in-wa-') ||
  token.length >= 20;

function answer(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const graphError = (res, status, code, message, extra = {}) =>
  answer(res, status, {
    error: { message, type: 'OAuthException', code, fbtrace_id: 'Astandin', ...extra },
  });

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function route(method, path, query, body, res) {
  const parts = path.split('/');
  if (method === 'GET' && path === 'me/accounts') return answer(res, 200, { data: PAGES });
  if (parts[1] === 'subscribed_apps') return answer(res, 200, { success: true });

  if (method === 'POST' && parts[1] === 'messages') {
    if (failNext) {
      const code = failNext;
      failNext = null;
      return graphError(res, 400, code, `Stand-in failure with code ${code}`);
    }
    seq += 1;
    if (body.messaging_product === 'whatsapp') {
      sent.push({
        id: `wamid.STANDIN${boot}${seq}`,
        channel: 'whatsapp',
        to: body.to,
        text: body.text?.body ?? '',
        at: new Date().toISOString(),
      });
      return answer(res, 200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: body.to, wa_id: body.to }],
        messages: [{ id: `wamid.STANDIN${boot}${seq}` }],
      });
    }
    const to = body.recipient?.id;
    if (!to) return graphError(res, 400, 100, 'param recipient must be non-empty');
    sent.push({
      id: `m_standin_${boot}_${seq}`,
      channel: 'page',
      account: parts[0],
      to,
      text: body.message?.text ?? '',
      at: new Date().toISOString(),
    });
    return answer(res, 200, { recipient_id: to, message_id: `m_standin_${boot}_${seq}` });
  }

  if (method === 'GET' && parts.length === 2 && parts[1] === 'phone_numbers')
    return answer(res, 200, {
      data: parts[0] === WHATSAPP.wabaId ? [{ id: WHATSAPP.phoneNumberId }] : [],
    });

  if (method === 'GET' && parts.length === 1) {
    if (parts[0].startsWith('wa-voice-'))
      return answer(res, 200, {
        messaging_product: 'whatsapp',
        id: parts[0],
        url: `http://127.0.0.1:${PORT}/__wa-media/${parts[0]}`,
        mime_type: 'audio/ogg; codecs=opus',
        sha256: createHash('sha256').update(VOICE_OGG).digest('hex'),
        file_size: VOICE_OGG.length,
      });
    if (parts[0].startsWith('wa-media-'))
      return demoPhoto(parts[0].slice('wa-media-'.length)).then((bytes) =>
        answer(res, 200, {
          messaging_product: 'whatsapp',
          id: parts[0],
          url: `http://127.0.0.1:${PORT}/__wa-media/${parts[0]}`,
          mime_type: 'image/jpeg',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          file_size: bytes.length,
        }),
      );
    if (parts[0] === WHATSAPP.phoneNumberId)
      return answer(res, 200, {
        id: WHATSAPP.phoneNumberId,
        display_phone_number: WHATSAPP.display_phone_number,
        verified_name: WHATSAPP.verified_name,
      });
    // Any other id is a customer profile.
    const tail = parts[0].slice(-4);
    return answer(
      res,
      200,
      query.fields?.includes('username')
        ? { id: parts[0], name: `Insta Customer ${tail}`, username: `customer${tail}` }
        : { id: parts[0], first_name: 'Demo', last_name: `Customer ${tail}` },
    );
  }
  return graphError(res, 400, 100, `Unknown path ${method} ${path}`);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';

  if (url.pathname === '/__sent') return answer(res, 200, { sent });
  // Like a CDN link: no token needed. Old links stop working.
  if (url.pathname.startsWith('/__photo/')) {
    const name = url.pathname.slice('/__photo/'.length).replace(/\.jpe?g$/, '');
    if (name === 'expired') return answer(res, 403, { error: 'URL signature expired' });
    console.log(`photo ${name}`);
    return sendPhoto(res, await demoPhoto(name));
  }
  if (url.pathname.startsWith('/__audio/')) {
    console.log(`voice clip ${url.pathname.slice('/__audio/'.length)}`);
    res.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': VOICE_MP4.length });
    return res.end(VOICE_MP4);
  }
  // Like WhatsApp's media store: the download needs the channel's token.
  if (url.pathname.startsWith('/__wa-media/')) {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !known(auth.slice(7)))
      return answer(res, 401, { error: 'Unauthorized' });
    if (url.pathname.startsWith('/__wa-media/wa-voice-')) {
      console.log(`whatsapp voice note ${url.pathname.slice('/__wa-media/'.length)}`);
      res.writeHead(200, {
        'content-type': 'audio/ogg',
        'content-length': VOICE_OGG.length,
      });
      return res.end(VOICE_OGG);
    }
    const id = url.pathname.slice('/__wa-media/wa-media-'.length);
    console.log(`whatsapp media ${id}`);
    return sendPhoto(res, await demoPhoto(id));
  }
  if (url.pathname === '/__fail' && method === 'POST') {
    failNext = Number((await readBody(req)).code ?? 613);
    return answer(res, 200, { failNext });
  }

  const [, , ...rest] = url.pathname.split('/');
  const path = rest.join('/');
  const query = Object.fromEntries(url.searchParams.entries());
  const body = method === 'POST' ? await readBody(req) : {};

  if (path === 'oauth/access_token') {
    if (query.grant_type === 'fb_exchange_token')
      return answer(res, 200, {
        access_token: `${query.fb_exchange_token}-long`,
        expires_in: 5_183_944,
      });
    if (!query.code) return graphError(res, 400, 100, 'Missing code');
    return answer(res, 200, {
      access_token: query.redirect_uri ? USER_TOKEN : `stand-in-wa-business-token`,
    });
  }

  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return graphError(res, 400, 104, 'An access token is required');
  if (query.appsecret_proof !== createHmac('sha256', SECRET).update(token).digest('hex'))
    return graphError(res, 400, 100, 'Invalid appsecret_proof provided in the API argument');
  if (!known(token)) return graphError(res, 400, 190, 'Invalid OAuth access token');

  console.log(`${method} ${path}`);
  return route(method, path, query, body, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Graph API stand-in on http://127.0.0.1:${PORT} (not Meta; for local checks only)`);
});
