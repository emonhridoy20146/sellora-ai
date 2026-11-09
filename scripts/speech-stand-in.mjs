/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for an OpenAI-style speech-to-text API (`POST /v1/audio/transcriptions`), for
 * local demos and browser checks when no real key is available. It is NOT speech
 * recognition: it never listens to the recording. It answers with a scripted sentence (set
 * the next one with POST /__say), in the request and response format of the real API, so
 * Sellora's whole voice note pipeline (storage, credits, live updates, the AI agent) runs as
 * it would with a real service.
 *
 *   node scripts/speech-stand-in.mjs     # listens on 127.0.0.1:4100
 *   AI_OPENAI_API_KEY=sk-stand-in AI_OPENAI_BASE_URL=http://127.0.0.1:4100/v1 npm run dev:worker
 *
 * Test hooks (not part of the API):
 *   POST /__say {"text":"..."}     the next answers say this (a list queues several)
 *   POST /__fail {"status":503}    the next answer is that HTTP error (400 = unreadable file)
 *   GET  /__requests               what each request carried (model, hints, file), newest last
 *   POST /__reset                  forget queued answers and the log
 *
 * Never point a production deployment at it.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4100);
const DEFAULT_TEXT = 'Ami ei lal jamdani saree ta nite chai. Dhaka te delivery charge koto?';

let says = [];
let failNext = null;
const requests = [];

const send = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const readAll = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';
  const raw = await readAll(req);

  if (url.pathname === '/__requests') return send(res, 200, { requests });
  if (url.pathname === '/__reset' && method === 'POST') {
    says = [];
    failNext = null;
    requests.length = 0;
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__say' && method === 'POST') {
    const body = JSON.parse(raw.toString('utf8') || '{}');
    says.push(...(Array.isArray(body.text) ? body.text : [String(body.text ?? '')]));
    return send(res, 200, { queued: says.length });
  }
  if (url.pathname === '/__fail' && method === 'POST') {
    failNext = Number(JSON.parse(raw.toString('utf8') || '{}').status ?? 503);
    return send(res, 200, { failNext });
  }

  if (method !== 'POST' || url.pathname !== '/v1/audio/transcriptions')
    return send(res, 404, { error: { message: `Unknown path ${method} ${url.pathname}` } });
  if (!(req.headers.authorization ?? '').startsWith('Bearer '))
    return send(res, 401, { error: { message: 'Missing API key', type: 'invalid_request_error' } });

  // The real multipart body, parsed the standard way.
  let form;
  try {
    form = await new Request('http://stand-in/', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? '' },
      body: raw,
    }).formData();
  } catch {
    return send(res, 400, {
      error: { message: 'Could not read the upload', type: 'invalid_request_error' },
    });
  }
  const file = form.get('file');
  const field = (name) => (typeof form.get(name) === 'string' ? form.get(name) : null);
  const entry = {
    at: new Date().toISOString(),
    model: field('model'),
    language: field('language'),
    prompt: field('prompt'),
    fileName: file && typeof file === 'object' ? file.name : null,
    fileType: file && typeof file === 'object' ? file.type : null,
    bytes: file && typeof file === 'object' ? file.size : 0,
  };
  requests.push(entry);
  if (requests.length > 50) requests.shift();
  console.log(`${entry.at} ${entry.model} ← ${entry.fileName} (${entry.bytes} bytes)`);

  if (!file || typeof file !== 'object' || !entry.model)
    return send(res, 400, {
      error: { message: 'file and model are required', type: 'invalid_request_error' },
    });
  if (failNext) {
    const status = failNext;
    failNext = null;
    return send(res, status, {
      error: { message: `Stand-in failure ${status}`, type: 'server_error' },
    });
  }
  return send(res, 200, { text: says.shift() ?? DEFAULT_TEXT });
}).listen(PORT, '127.0.0.1', () =>
  console.log(`Speech-to-text stand-in (scripted, does not listen) on http://127.0.0.1:${PORT}`),
);
