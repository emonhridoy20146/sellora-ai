/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for the Steadfast, Pathao and RedX merchant APIs, for local demos and browser
 * checks when no real courier account is available. It is NOT a courier: nothing is picked
 * up or delivered. It answers in the request and response shapes of the couriers' APIs (as
 * published in their SDKs), so Sellora's booking and tracking run as they would for real.
 *
 *   node scripts/courier-stand-in.mjs     # listens on 127.0.0.1:4030
 *   COURIER_STEADFAST_BASE_URL=http://127.0.0.1:4030/steadfast/api/v1 \
 *   COURIER_PATHAO_BASE_URL=http://127.0.0.1:4030/pathao \
 *   COURIER_PATHAO_SANDBOX_URL=http://127.0.0.1:4030/pathao \
 *   COURIER_REDX_BASE_URL=http://127.0.0.1:4030/redx/v1.0.0-beta \
 *   COURIER_REDX_SANDBOX_URL=http://127.0.0.1:4030/redx/v1.0.0-beta  npm run dev   # and dev:worker
 *
 * Demo credentials (anything else is refused, like a real courier would):
 *   Steadfast  API key demo-steadfast-key, secret key demo-steadfast-secret
 *   Pathao     client demo-pathao-client / demo-pathao-secret, login demo@sellora.test / demo-pathao-password
 *   RedX       token demo-redx-token-0000000000
 *
 * Test hooks (not part of any courier API):
 *   GET  /__parcels                        parcels booked so far
 *   POST /__advance {"id","status","notify":{"url","secret"}}
 *        moves a parcel to a courier status word and, with notify, sends the courier's
 *        webhook to that address (Steadfast: bearer token; Pathao: X-PATHAO-Signature)
 *   POST /__fail {"provider","fault"}       the next booking fails: "lose-reply" (the parcel
 *        is made, then the connection drops) or an HTTP status such as 500
 *
 * Never point a production deployment at it.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4030);
const STEADFAST = { key: 'demo-steadfast-key', secret: 'demo-steadfast-secret', balance: 2450 };
const PATHAO = {
  clientId: 'demo-pathao-client',
  clientSecret: 'demo-pathao-secret',
  username: 'demo@sellora.test',
  password: 'demo-pathao-password',
  stores: [
    {
      store_id: 90001,
      store_name: 'Sellora Demo Warehouse',
      store_address: 'House 10, Road 27, Dhanmondi, Dhaka',
    },
  ],
};
const REDX_TOKEN = 'demo-redx-token-0000000000';
const REDX_STORES = [{ id: 7001, name: 'Sellora Demo Pickup', address: 'Mohammadpur, Dhaka' }];
const CITIES = [
  { city_id: 1, city_name: 'Dhaka' },
  { city_id: 2, city_name: 'Chattogram' },
  { city_id: 3, city_name: 'Sylhet' },
];
const ZONES = {
  1: [
    { zone_id: 101, zone_name: 'Dhanmondi' },
    { zone_id: 102, zone_name: 'Gulshan' },
    { zone_id: 103, zone_name: 'Mirpur' },
    { zone_id: 104, zone_name: 'Uttara' },
  ],
  2: [{ zone_id: 201, zone_name: 'Agrabad' }],
  3: [{ zone_id: 301, zone_name: 'Zindabazar' }],
};
const AREAS = {
  101: [
    { area_id: 10101, area_name: 'Road 27', home_delivery_available: true },
    { area_id: 10102, area_name: 'Jigatola', home_delivery_available: true },
  ],
  102: [{ area_id: 10201, area_name: 'Gulshan 1', home_delivery_available: true }],
  103: [{ area_id: 10301, area_name: 'Mirpur 10', home_delivery_available: true }],
  104: [{ area_id: 10401, area_name: 'Sector 7', home_delivery_available: true }],
};
const REDX_AREAS = [
  { id: 1, name: 'Mohammadpur', post_code: 1207, division_name: 'Dhaka', zone_id: 1 },
  { id: 2, name: 'Dhanmondi', post_code: 1209, division_name: 'Dhaka', zone_id: 1 },
  { id: 3, name: 'Gulshan', post_code: 1212, division_name: 'Dhaka', zone_id: 1 },
  { id: 4, name: 'Mirpur', post_code: 1216, division_name: 'Dhaka', zone_id: 1 },
  { id: 5, name: 'Agrabad', post_code: 4100, division_name: 'Chattogram', zone_id: 2 },
];

const parcels = [];
const pathaoTokens = new Set();
const faults = [];
let seq = 0;
const boot = Date.now().toString(36).slice(-4).toUpperCase();

function answer(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

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

/** Applies a queued fault; true when the response was handled. */
function fault(provider, res, make) {
  const i = faults.findIndex((f) => f.provider === provider);
  if (i < 0) return false;
  const [{ fault: f }] = faults.splice(i, 1);
  if (f === 'lose-reply') {
    make();
    console.log(`${provider}: booking made, reply dropped on purpose`);
    res.socket.destroy();
    return true;
  }
  answer(res, Number(f) || 500, { message: 'Stand-in failure' });
  return true;
}

function steadfast(method, path, headers, body, res) {
  if (headers['api-key'] !== STEADFAST.key || headers['secret-key'] !== STEADFAST.secret)
    return answer(res, 401, { message: 'Unauthorized' });
  if (method === 'GET' && path === '/get_balance')
    return answer(res, 200, { status: 200, current_balance: STEADFAST.balance });
  if (method === 'POST' && path === '/create_order') {
    const errors = {};
    if (!/^01\d{9}$/.test(String(body.recipient_phone)))
      errors.recipient_phone = ['The recipient phone must be 11 digits.'];
    if (parcels.some((p) => p.provider === 'steadfast' && p.invoice === body.invoice))
      errors.invoice = ['The invoice has already been taken.'];
    if (Object.keys(errors).length)
      return answer(res, 422, { message: 'Validation failed', errors });
    seq += 1;
    const p = {
      provider: 'steadfast',
      id: String(5_000_000 + seq),
      trackingCode: `SFD${boot}${seq}`,
      invoice: String(body.invoice),
      status: 'in_review',
      body,
      at: new Date().toISOString(),
    };
    if (fault('steadfast', res, () => parcels.push(p))) return;
    parcels.push(p);
    console.log(`steadfast: booked ${p.invoice} as ${p.id}`);
    return answer(res, 200, {
      status: 200,
      message: 'Consignment has been created successfully.',
      consignment: {
        consignment_id: Number(p.id),
        invoice: p.invoice,
        tracking_code: p.trackingCode,
        recipient_name: body.recipient_name,
        recipient_phone: body.recipient_phone,
        recipient_address: body.recipient_address,
        cod_amount: body.cod_amount,
        status: 'in_review',
        note: body.note ?? null,
        created_at: p.at,
        updated_at: p.at,
      },
    });
  }
  const m = /^\/status_by_(cid|invoice|trackingcode)\/(.+)$/.exec(path);
  if (method === 'GET' && m) {
    const key = decodeURIComponent(m[2]);
    const p = parcels.find(
      (x) =>
        x.provider === 'steadfast' &&
        (m[1] === 'cid'
          ? x.id === key
          : m[1] === 'invoice'
            ? x.invoice === key
            : x.trackingCode === key),
    );
    if (!p) return answer(res, 404, { status: 404, message: 'Consignment not found.' });
    return answer(res, 200, { status: 200, delivery_status: p.status });
  }
  return answer(res, 404, { message: 'Not found' });
}

function pathao(method, path, headers, body, res) {
  const api = '/aladdin/api/v1';
  if (method === 'POST' && path === `${api}/issue-token`) {
    const ok =
      body.grant_type === 'password' &&
      body.client_id === PATHAO.clientId &&
      body.client_secret === PATHAO.clientSecret &&
      body.username === PATHAO.username &&
      body.password === PATHAO.password;
    if (!ok)
      return answer(res, 400, {
        message: 'The user credentials were incorrect.',
        type: 'error',
        code: 400,
      });
    const token = `stand-in-pathao-${randomBytes(12).toString('hex')}`;
    pathaoTokens.add(token);
    return answer(res, 200, {
      token_type: 'Bearer',
      expires_in: 432_000,
      access_token: token,
      refresh_token: `r-${token}`,
    });
  }
  const token = (headers.authorization ?? '').replace(/^Bearer /, '');
  if (!pathaoTokens.has(token)) return answer(res, 401, { message: 'Unauthenticated.' });
  if (method === 'GET' && path === `${api}/stores`)
    return answer(res, 200, {
      code: 200,
      type: 'success',
      data: { data: PATHAO.stores.map((s) => ({ ...s, is_active: 1 })) },
    });
  if (method === 'GET' && path === `${api}/city-list`)
    return answer(res, 200, { code: 200, data: { data: CITIES } });
  let m = new RegExp(`^${api}/cities/(\\d+)/zone-list$`).exec(path);
  if (method === 'GET' && m)
    return answer(res, 200, { code: 200, data: { data: ZONES[m[1]] ?? [] } });
  m = new RegExp(`^${api}/zones/(\\d+)/area-list$`).exec(path);
  if (method === 'GET' && m)
    return answer(res, 200, { code: 200, data: { data: AREAS[m[1]] ?? [] } });
  if (method === 'POST' && path === `${api}/orders`) {
    const errors = {};
    if (!PATHAO.stores.some((s) => s.store_id === body.store_id))
      errors.store_id = ['The selected store id is invalid.'];
    if (!/^01\d{9}$/.test(String(body.recipient_phone)))
      errors.recipient_phone = ['The recipient phone format is invalid.'];
    if (String(body.recipient_address ?? '').length < 10)
      errors.recipient_address = ['The recipient address must be at least 10 characters.'];
    if (Object.keys(errors).length)
      return answer(res, 422, {
        message: 'Please fix the given errors',
        type: 'error',
        code: 422,
        errors,
      });
    seq += 1;
    const id = `DP${boot}${String(seq).padStart(5, '0')}`;
    const p = {
      provider: 'pathao',
      id,
      trackingCode: id,
      invoice: String(body.merchant_order_id),
      status: 'Pending',
      body,
      at: new Date().toISOString(),
    };
    if (fault('pathao', res, () => parcels.push(p))) return;
    parcels.push(p);
    console.log(`pathao: booked ${p.invoice} as ${id}`);
    return answer(res, 200, {
      message: 'Order Created Successfully',
      type: 'success',
      code: 200,
      data: {
        consignment_id: id,
        merchant_order_id: p.invoice,
        order_status: 'Pending',
        delivery_fee: 70,
      },
    });
  }
  m = new RegExp(`^${api}/orders/([^/]+)/info$`).exec(path);
  if (method === 'GET' && m) {
    const p = parcels.find((x) => x.provider === 'pathao' && x.id === decodeURIComponent(m[1]));
    if (!p) return answer(res, 404, { message: 'Order not found', type: 'error', code: 404 });
    return answer(res, 200, {
      type: 'success',
      code: 200,
      data: {
        consignment_id: p.id,
        merchant_order_id: p.invoice,
        order_status: p.status.replace(/_/g, ' '),
        order_status_slug: p.status,
      },
    });
  }
  return answer(res, 404, { message: 'Not found' });
}

function redx(method, path, headers, body, res) {
  if ((headers['api-access-token'] ?? '') !== `Bearer ${REDX_TOKEN}`)
    return answer(res, 401, { message: 'Unauthorized' });
  if (method === 'GET' && path === '/pickup/stores')
    return answer(res, 200, { pickup_stores: REDX_STORES });
  if (method === 'GET' && path === '/areas') return answer(res, 200, { areas: REDX_AREAS });
  if (method === 'POST' && path === '/parcel') {
    if (!REDX_AREAS.some((a) => a.id === body.delivery_area_id))
      return answer(res, 400, { message: 'Invalid delivery area' });
    seq += 1;
    const id = `${boot}RX${String(seq).padStart(5, '0')}`;
    const p = {
      provider: 'redx',
      id,
      trackingCode: id,
      invoice: String(body.merchant_invoice_id),
      status: 'pickup-pending',
      body,
      at: new Date().toISOString(),
    };
    if (fault('redx', res, () => parcels.push(p))) return;
    parcels.push(p);
    console.log(`redx: booked ${p.invoice} as ${id}`);
    return answer(res, 200, { tracking_id: id });
  }
  const m = /^\/parcel\/info\/(.+)$/.exec(path);
  if (method === 'GET' && m) {
    const p = parcels.find((x) => x.provider === 'redx' && x.id === decodeURIComponent(m[1]));
    if (!p) return answer(res, 404, { message: 'Parcel not found' });
    return answer(res, 200, {
      parcel: { tracking_id: p.id, status: p.status, merchant_invoice_id: p.invoice },
    });
  }
  return answer(res, 404, { message: 'Not found' });
}

/** Sends the courier's webhook the way that courier does. */
async function notify(p, target) {
  const headers = { 'content-type': 'application/json' };
  let body;
  if (p.provider === 'steadfast') {
    headers.authorization = `Bearer ${target.secret}`;
    body = {
      notification_type: 'delivery_status',
      consignment_id: Number(p.id),
      invoice: p.invoice,
      status: p.status,
      updated_at: new Date().toISOString(),
    };
  } else if (p.provider === 'pathao') {
    headers['x-pathao-signature'] = target.secret;
    body = {
      consignment_id: p.id,
      merchant_order_id: p.invoice,
      event: `order.${p.status.toLowerCase().replace(/_/g, '-')}`,
      updated_at: new Date().toISOString(),
    };
  } else {
    body = {
      tracking_number: p.id,
      status: p.status,
      invoice_number: p.invoice,
      timestamp: new Date().toISOString(),
    };
  }
  const res = await fetch(target.url, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.text() };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';
  const body = method === 'POST' || method === 'PATCH' ? await readBody(req) : {};

  if (url.pathname === '/__parcels') return answer(res, 200, { parcels });
  if (url.pathname === '/__fail' && method === 'POST') {
    faults.push({ provider: body.provider, fault: body.fault ?? 500 });
    return answer(res, 200, { faults });
  }
  if (url.pathname === '/__advance' && method === 'POST') {
    const p = parcels.find((x) => x.id === String(body.id) || x.invoice === String(body.id));
    if (!p) return answer(res, 404, { message: 'No such parcel' });
    p.status = String(body.status);
    console.log(`${p.provider}: ${p.id} is now ${p.status}`);
    const webhook = body.notify?.url
      ? await notify(p, body.notify).catch((err) => ({ error: String(err) }))
      : null;
    return answer(res, 200, { parcel: p, webhook });
  }

  const routes = [
    ['/steadfast/api/v1', steadfast],
    ['/pathao', pathao],
    ['/redx/v1.0.0-beta', redx],
  ];
  for (const [prefix, handler] of routes) {
    if (!url.pathname.startsWith(prefix)) continue;
    const path = url.pathname.slice(prefix.length) || '/';
    console.log(`${method} ${prefix}${path}`);
    return handler(method, path, req.headers, body, res);
  }
  return answer(res, 404, { message: `Unknown path ${url.pathname}` });
}).listen(PORT, '127.0.0.1', () => {
  console.log(
    `Courier stand-in on http://127.0.0.1:${PORT} (not a courier; for local checks only)`,
  );
});
