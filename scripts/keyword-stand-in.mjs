/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for DataForSEO's Google Ads search volume endpoint (ADR 0032), for trying
 * keyword research locally without a DataForSEO account. It is NOT DataForSEO and NOT Google:
 * every number it returns is MADE UP from a hash of the keyword (about a quarter of keywords
 * get "no data", like real rare phrases). It speaks the documented request and response
 * shape of POST /v3/keywords_data/google_ads/search_volume/live, so Sellora's client, the
 * cache and the credit charge run exactly as with the real service.
 *
 *   node scripts/keyword-stand-in.mjs     # listens on 127.0.0.1:4130 (HOST, PORT to change)
 *
 * Point the API and the worker at it (.env), then restart them:
 *
 *   KEYWORDS_DATAFORSEO_LOGIN=stand-in@example.test
 *   KEYWORDS_DATAFORSEO_PASSWORD=stand-in-keyword-password
 *   KEYWORDS_DATAFORSEO_URL=http://127.0.0.1:4130
 *
 *   curl localhost:4130/__calls          # what was asked (keywords per lookup)
 *   curl -X POST localhost:4130/__fail   # the next lookup fails (as if the service were down)
 *
 * Never point a production deployment at it.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4130);
const LOGIN = process.env.KEYWORDS_DATAFORSEO_LOGIN ?? 'stand-in@example.test';
const PASSWORD = process.env.KEYWORDS_DATAFORSEO_PASSWORD ?? 'stand-in-keyword-password';
const PATH = '/v3/keywords_data/google_ads/search_volume/live';
/** Google Ads rounds volumes to buckets like these. */
const BUCKETS = [
  10, 20, 30, 40, 50, 70, 90, 110, 140, 170, 210, 260, 320, 390, 480, 590, 720, 880, 1000, 1300,
  1600, 1900, 2400, 2900, 3600, 4400, 5400, 6600, 8100, 9900, 12100, 14800, 18100,
];

const calls = [];
let total = 0;
let failNext = false;

function unit(text) {
  return createHash('sha256').update(text).digest().readUInt32BE(0) / 2 ** 32;
}

/** Made-up numbers for one keyword; the same keyword always gets the same ones. */
function made(keyword, locationCode) {
  const u = unit(`${keyword}|${locationCode}`);
  if (u < 0.25) return null;
  // Shorter phrases are searched more, as in real data.
  const words = keyword.split(/\s+/).length;
  const reach = Math.max(0, Math.min(1, (u - 0.25) / 0.75 - (words - 2) * 0.12));
  const volume = BUCKETS[Math.floor(reach * (BUCKETS.length - 1))];
  const competitionIndex = Math.round(100 * unit(`c|${keyword}`));
  const season = unit(`s|${keyword}`) * Math.PI * 2;
  const now = new Date();
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1 - i, 1));
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      search_volume: Math.max(0, Math.round(volume * (1 + 0.35 * Math.sin(season + i / 2)))),
    };
  });
  return {
    volume,
    competition: competitionIndex > 66 ? 'HIGH' : competitionIndex > 33 ? 'MEDIUM' : 'LOW',
    competitionIndex,
    cpc: Math.round((0.01 + 0.4 * unit(`p|${keyword}`)) * 100) / 100,
    monthly,
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/__calls') return send(res, 200, { total, calls });
    if (req.method === 'POST' && req.url === '/__fail') {
      failNext = true;
      return send(res, 200, { failNext });
    }
    if (req.method !== 'POST' || req.url !== PATH)
      return send(res, 404, { status_code: 40400, status_message: 'Not Found.' });
    const expected = `Basic ${Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64')}`;
    if (req.headers.authorization !== expected)
      return send(res, 401, { status_code: 40100, status_message: 'You are not authorized.' });
    if (failNext) {
      failNext = false;
      return send(res, 500, { status_code: 50000, status_message: 'Internal Error.' });
    }
    let task;
    try {
      [task] = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(res, 400, { status_code: 40501, status_message: 'Invalid Field.' });
    }
    const keywords = Array.isArray(task?.keywords) ? task.keywords : [];
    const locationCode = task?.location_code ?? 2050;
    total += 1;
    calls.push({ at: new Date().toISOString(), keywords, locationCode });
    if (calls.length > 50) calls.shift();
    const result = keywords.map((keyword) => {
      const m = made(keyword, locationCode);
      return {
        keyword,
        spell: null,
        location_code: locationCode,
        language_code: null,
        search_partners: false,
        competition: m?.competition ?? null,
        competition_index: m?.competitionIndex ?? null,
        search_volume: m?.volume ?? null,
        low_top_of_page_bid: m ? m.cpc / 2 : null,
        high_top_of_page_bid: m ? m.cpc * 2 : null,
        cpc: m?.cpc ?? null,
        monthly_searches: m?.monthly ?? null,
      };
    });
    console.log(`${new Date().toISOString()} ${keywords.length} keywords (made-up volumes)`);
    send(res, 200, {
      version: '0.1.stand-in',
      status_code: 20000,
      status_message: 'Ok.',
      time: '0.01 sec.',
      cost: 0.075,
      tasks_count: 1,
      tasks_error: 0,
      tasks: [
        {
          id: `stand-in-${calls.length}`,
          status_code: 20000,
          status_message: 'Ok.',
          time: '0.01 sec.',
          cost: 0.075,
          result_count: result.length,
          path: ['v3', 'keywords_data', 'google_ads', 'search_volume', 'live'],
          data: { api: 'keywords_data', function: 'search_volume', se: 'google_ads' },
          result,
        },
      ],
    });
  });
});

server.listen(PORT, HOST, () =>
  console.log(
    `Keyword volume stand-in (NOT DataForSEO; made-up numbers) on http://${HOST}:${PORT}`,
  ),
);
