/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for the bKash, Nagad, SSLCommerz, aamarPay and shurjoPay merchant APIs, for local
 * demos and browser checks when no merchant account is available (ADR 0029). It is NOT a
 * payment gateway: no money moves. It answers in the request and response shapes of each
 * gateway's published API, and shows a payment page with Pay and Cancel buttons that sends the
 * shopper back the way that gateway does, so Sellora's checkout runs as it would for real.
 *
 *   node scripts/payment-stand-in.mjs     # listens on 127.0.0.1:4110 (HOST, PORT to change)
 *   PAYMENT_BKASH_SANDBOX_URL=http://127.0.0.1:4110/bkash \
 *   PAYMENT_NAGAD_SANDBOX_URL=http://127.0.0.1:4110/nagad \
 *   PAYMENT_SSLCOMMERZ_SANDBOX_URL=http://127.0.0.1:4110/sslcommerz \
 *   PAYMENT_AAMARPAY_SANDBOX_URL=http://127.0.0.1:4110/aamarpay \
 *   PAYMENT_SHURJOPAY_SANDBOX_URL=http://127.0.0.1:4110/shurjopay  npm run dev   # and dev:worker
 * (connect each gateway with "Sandbox" on in Settings › Payments).
 *
 * Demo keys (anything else is refused, like a real gateway would):
 *   bKash       app key demo-bkash-app-key, app secret demo-bkash-app-secret,
 *               username demo-bkash-user, password demo-bkash-password
 *   Nagad       merchant ID 683002007104225, number 01711428036, and the two keys from
 *               GET /__nagad-keys (made fresh each time the stand-in starts)
 *   SSLCommerz  store ID demosellora01, store password demosellora01@ssl
 *   aamarPay    store ID aamarpaytest, signature key demo-aamarpay-signature-key
 *   shurjoPay   username demo-shurjopay, password demo-shurjopay-password, prefix DEMO
 *
 * Test hooks (not part of any gateway API):
 *   GET  /__requests      what was asked of it      POST /__reset   forget everything
 *   GET  /__payments      payments and their state  POST /__fail    the next payment start fails
 *   GET  /__nagad-keys    the Nagad keys to paste into Settings › Payments
 *   POST /__pay/<ref>     mark a payment paid without the page (a shopper who never comes back)
 *
 * Never point a production deployment at it.
 */
import {
  constants,
  createSign,
  createVerify,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
} from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4110);
// 0.0.0.0 inside a container (compose.yaml's payment-stand-in service); this computer only otherwise.
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC = (process.env.STAND_IN_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');

const KEYS = {
  bkash: {
    appKey: 'demo-bkash-app-key',
    appSecret: 'demo-bkash-app-secret',
    username: 'demo-bkash-user',
    password: 'demo-bkash-password',
  },
  nagad: { merchantId: '683002007104225', merchantNumber: '01711428036' },
  sslcommerz: { storeId: 'demosellora01', storePassword: 'demosellora01@ssl' },
  aamarpay: { storeId: 'aamarpaytest', signatureKey: 'demo-aamarpay-signature-key' },
  shurjopay: { username: 'demo-shurjopay', password: 'demo-shurjopay-password', prefix: 'DEMO' },
};
const NAMES = {
  bkash: 'bKash',
  nagad: 'Nagad',
  sslcommerz: 'SSLCommerz',
  aamarpay: 'aamarPay',
  shurjopay: 'shurjoPay',
};

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const nagad = generateKeyPairSync('rsa', { modulusLength: 2048 });
const nagadKeys = {
  merchantPrivateKey: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  nagadPublicKey: nagad.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};

/** ref -> payment */
const payments = new Map();
const challenges = new Map();
const requests = [];
let failNext = false;

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' && type !== 'application/json' ? body : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const bySession = (id) => [...payments.values()].find((p) => p.sessionId === id);
const short = (ref) => ref.slice(-6);

function addPayment(p) {
  payments.set(p.ref, { state: 'open', ...p, createdAt: new Date().toISOString() });
  return `${PUBLIC}/pay/${p.ref}`;
}

/** Where the gateway sends the shopper after the page, and how. */
function backTo(p, paid) {
  const u = (base, params) => {
    const url = new URL(base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  };
  switch (p.gateway) {
    case 'bkash':
      return {
        method: 'GET',
        url: u(p.callbackURL, {
          paymentID: p.sessionId,
          status: paid ? 'success' : 'cancel',
          signature: 'stand-in',
        }),
      };
    case 'nagad':
      return {
        method: 'GET',
        url: u(p.callbackURL, {
          merchant: KEYS.nagad.merchantId,
          order_id: p.ref,
          payment_ref_id: p.sessionId,
          status: paid ? 'Success' : 'Aborted',
          status_code: paid ? '00_0000_000' : '00_1000_001',
          message: paid ? 'Successful Transaction' : 'Aborted by customer',
          payment_dt: new Date().toISOString().replace(/\D/g, '').slice(0, 14),
          issuer_payment_ref: paid ? `NGTRX${short(p.ref)}` : '',
        }),
      };
    case 'sslcommerz':
      return paid
        ? {
            method: 'POST',
            url: p.success,
            form: {
              tran_id: p.ref,
              val_id: p.valId,
              amount: p.amount,
              status: 'VALID',
              currency: 'BDT',
            },
          }
        : { method: 'POST', url: p.cancel, form: { tran_id: p.ref, status: 'CANCELLED' } };
    case 'aamarpay':
      return paid
        ? {
            method: 'POST',
            url: p.success,
            form: {
              mer_txnid: p.ref,
              pg_txnid: `AAM${short(p.ref)}`,
              pay_status: 'Successful',
              amount: p.amount,
            },
          }
        : { method: 'GET', url: p.cancel };
    default:
      return { method: 'GET', url: u(paid ? p.success : p.cancel, { order_id: p.sessionId }) };
  }
}

function payPage(p) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(NAMES[p.gateway])} payment (stand-in)</title>
<style>
body{font-family:system-ui,sans-serif;background:#f4f4f5;color:#18181b;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:28px;max-width:380px;width:calc(100% - 32px);box-sizing:border-box}
.warn{background:#fef3c7;color:#78350f;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:18px}
h1{font-size:20px;margin:0 0 4px}.amount{font-size:32px;font-weight:700;margin:16px 0}
p{margin:4px 0;color:#52525b;font-size:14px}button{width:100%;height:46px;border-radius:10px;border:0;font-size:16px;font-weight:600;margin-top:10px;cursor:pointer}
.pay{background:#16a34a;color:#fff}.cancel{background:#e4e4e7;color:#18181b}
</style></head><body><main>
<div class="warn">Stand-in for ${esc(NAMES[p.gateway])}. Not a real payment gateway: no money moves.</div>
<h1>${esc(NAMES[p.gateway])}</h1><p>${esc(p.description ?? '')}</p>
<p>Reference ${esc(p.ref)}</p>
<div class="amount">৳${esc(p.amount)}</div>
<form method="post" action="/pay/${esc(p.ref)}/paid"><button class="pay" type="submit">Pay ৳${esc(p.amount)}</button></form>
<form method="post" action="/pay/${esc(p.ref)}/cancelled"><button class="cancel" type="submit">Cancel</button></form>
</main></body></html>`;
}

function redirectPage(target) {
  if (target.method === 'GET') return { status: 303, location: target.url };
  const fields = Object.entries(target.form)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return {
    status: 200,
    html: `<!doctype html><html><body><p>Returning to the shop…</p><form id="f" method="post" action="${esc(target.url)}">${fields}</form><script>document.getElementById('f').submit()</script></body></html>`,
  };
}

function nagadDecrypt(b64) {
  return privateDecrypt(
    { key: nagad.privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(b64, 'base64'),
  ).toString();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;
  const raw = await readBody(req);
  if (!path.startsWith('/__') && !path.startsWith('/pay/'))
    requests.push({
      at: new Date().toISOString(),
      method: req.method,
      path,
      body: raw.slice(0, 2000),
    });

  // ------------------------------------------------------------ hooks
  if (path === '/__requests') return send(res, 200, requests);
  if (path === '/__payments') return send(res, 200, [...payments.values()]);
  if (path === '/__nagad-keys') return send(res, 200, nagadKeys);
  if (path === '/__reset' && req.method === 'POST') {
    payments.clear();
    requests.length = 0;
    failNext = false;
    return send(res, 200, { ok: true });
  }
  if (path === '/__fail' && req.method === 'POST') {
    failNext = true;
    return send(res, 200, { ok: true });
  }
  const hookPay = /^\/__pay\/([A-Z0-9]+)$/.exec(path);
  if (hookPay && req.method === 'POST') {
    const p = payments.get(hookPay[1]);
    if (!p) return send(res, 404, { error: 'no such payment' });
    p.state = 'paid';
    return send(res, 200, p);
  }

  // ------------------------------------------------------------ the payment page
  const page = /^\/pay\/([A-Z0-9]+)(?:\/(paid|cancelled))?$/.exec(path);
  if (page) {
    const p = payments.get(page[1]);
    if (!p) return send(res, 404, 'No such payment', 'text/plain');
    if (!page[2]) return send(res, 200, payPage(p), 'text/html; charset=utf-8');
    p.state = page[2];
    const r = redirectPage(backTo(p, page[2] === 'paid'));
    if (r.location) {
      res.writeHead(303, { location: r.location });
      return res.end();
    }
    return send(res, 200, r.html, 'text/html; charset=utf-8');
  }

  const startPath =
    path.endsWith('/tokenized/checkout/create') ||
    path.includes('/check-out/initialize/') ||
    path.endsWith('/gwprocess/v4/api.php') ||
    path.endsWith('/jsonpost.php') ||
    path.endsWith('/api/secret-pay');
  if (failNext && startPath) {
    failNext = false;
    return send(res, 503, {
      status: 'FAILED',
      failedreason: 'Stand-in maintenance',
      message: 'Service unavailable',
    });
  }

  // ------------------------------------------------------------ bKash
  if (path === '/bkash/tokenized/checkout/token/grant') {
    const b = json(raw);
    if (
      b.app_key !== KEYS.bkash.appKey ||
      b.app_secret !== KEYS.bkash.appSecret ||
      req.headers.username !== KEYS.bkash.username ||
      req.headers.password !== KEYS.bkash.password
    )
      return send(res, 401, { statusCode: '2079', statusMessage: 'Invalid app key or secret' });
    return send(res, 200, {
      statusCode: '0000',
      id_token: 'stand-in-bkash-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  }
  if (path === '/bkash/tokenized/checkout/create') {
    const b = json(raw);
    const sessionId = `TR00${b.merchantInvoiceNumber}`;
    const page = addPayment({
      gateway: 'bkash',
      ref: b.merchantInvoiceNumber,
      sessionId,
      amount: b.amount,
      callbackURL: b.callbackURL,
      description: `Payer ${b.payerReference}`,
    });
    return send(res, 200, {
      statusCode: '0000',
      statusMessage: 'Successful',
      paymentID: sessionId,
      bkashURL: page,
      transactionStatus: 'Initiated',
      amount: b.amount,
      currency: 'BDT',
      merchantInvoiceNumber: b.merchantInvoiceNumber,
    });
  }
  if (
    path === '/bkash/tokenized/checkout/execute' ||
    path === '/bkash/tokenized/checkout/payment/status'
  ) {
    const p = bySession(json(raw).paymentID);
    if (!p) return send(res, 200, { statusCode: '2056', statusMessage: 'Invalid Payment State' });
    const status = { open: 'Initiated', paid: 'Completed', cancelled: 'Cancelled' }[p.state];
    return send(res, 200, {
      statusCode: '0000',
      statusMessage: 'Successful',
      paymentID: p.sessionId,
      transactionStatus: status,
      amount: p.amount,
      currency: 'BDT',
      merchantInvoiceNumber: p.ref,
      ...(p.state === 'paid' ? { trxID: `BKTRX${short(p.ref)}` } : {}),
    });
  }

  // ------------------------------------------------------------ Nagad
  const init = /^\/nagad\/api\/dfs\/check-out\/initialize\/(\d+)\/([A-Z0-9]+)$/.exec(path);
  if (init) {
    const b = json(raw);
    let plain;
    try {
      plain = nagadDecrypt(b.sensitiveData);
    } catch {
      return send(res, 400, {
        reason: 'INVALID_ENCRYPTION',
        message: 'Could not decrypt the request',
      });
    }
    const signed = createVerify('SHA256')
      .update(plain)
      .verify(merchant.publicKey, b.signature ?? '', 'base64');
    if (
      !signed ||
      init[1] !== KEYS.nagad.merchantId ||
      b.accountNumber !== KEYS.nagad.merchantNumber
    )
      return send(res, 400, { reason: 'INVALID_SIGNATURE', message: 'Merchant keys do not match' });
    const paymentReferenceId = `MDkyMjIz${init[2]}`;
    const challenge = `CH${Date.now().toString(36).toUpperCase()}`;
    challenges.set(paymentReferenceId, { ref: init[2], challenge });
    const answer = JSON.stringify({
      paymentReferenceId,
      challenge,
      acceptDateTime: new Date().toISOString(),
    });
    return send(res, 200, {
      sensitiveData: publicEncrypt(
        { key: merchant.publicKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(answer),
      ).toString('base64'),
      signature: createSign('SHA256').update(answer).sign(nagad.privateKey, 'base64'),
    });
  }
  const complete = /^\/nagad\/api\/dfs\/check-out\/complete\/(.+)$/.exec(path);
  if (complete) {
    const b = json(raw);
    const known = challenges.get(complete[1]);
    let data;
    try {
      data = JSON.parse(nagadDecrypt(b.sensitiveData));
    } catch {
      return send(res, 400, {
        reason: 'INVALID_ENCRYPTION',
        message: 'Could not decrypt the request',
      });
    }
    if (!known || known.challenge !== data.challenge)
      return send(res, 400, { reason: 'INVALID_CHALLENGE', message: 'Challenge does not match' });
    const page = addPayment({
      gateway: 'nagad',
      ref: data.orderId,
      sessionId: complete[1],
      amount: data.amount,
      callbackURL: b.merchantCallbackURL,
      description: b.additionalMerchantInfo?.productDetails,
    });
    return send(res, 200, { status: 'Success', callBackUrl: page });
  }
  const verify = /^\/nagad\/api\/dfs\/verify\/payment\/(.+)$/.exec(path);
  if (verify) {
    const p = bySession(decodeURIComponent(verify[1]));
    if (!p)
      return send(res, 200, { status: 'Unknown', statusCode: '404', message: 'No such payment' });
    const status = { open: 'Ready', paid: 'Success', cancelled: 'Aborted' }[p.state];
    return send(res, 200, {
      merchantId: KEYS.nagad.merchantId,
      orderId: p.ref,
      paymentRefId: p.sessionId,
      amount: p.amount,
      clientMobileNo: '017****8036',
      merchantMobileNo: KEYS.nagad.merchantNumber,
      orderDateTime: p.createdAt,
      issuerPaymentDateTime: p.createdAt,
      issuerPaymentRefNo: p.state === 'paid' ? `NGTRX${short(p.ref)}` : null,
      status,
      statusCode: p.state === 'paid' ? '000' : '001',
    });
  }

  // ------------------------------------------------------------ SSLCommerz
  if (path === '/sslcommerz/gwprocess/v4/api.php') {
    const f = new URLSearchParams(raw);
    if (
      f.get('store_id') !== KEYS.sslcommerz.storeId ||
      f.get('store_passwd') !== KEYS.sslcommerz.storePassword
    )
      return send(res, 200, {
        status: 'FAILED',
        failedreason: 'Store Credential Error Or Store is De-active',
      });
    const ref = f.get('tran_id');
    const page = addPayment({
      gateway: 'sslcommerz',
      ref,
      sessionId: `SK${ref}`,
      valId: `VAL${ref}`,
      amount: f.get('total_amount'),
      success: f.get('success_url'),
      cancel: f.get('cancel_url'),
      description: f.get('product_name'),
    });
    return send(res, 200, { status: 'SUCCESS', sessionkey: `SK${ref}`, GatewayPageURL: page });
  }
  if (path === '/sslcommerz/validator/api/merchantTransIDvalidationAPI.php') {
    const q = url.searchParams;
    if (
      q.get('store_id') !== KEYS.sslcommerz.storeId ||
      q.get('store_passwd') !== KEYS.sslcommerz.storePassword
    )
      return send(res, 200, { APIConnect: 'INVALID_REQUEST' });
    const p = payments.get(q.get('tran_id') ?? '');
    const element =
      p && p.state !== 'open'
        ? [
            {
              tran_id: p.ref,
              val_id: p.valId,
              amount: p.amount,
              status: p.state === 'paid' ? 'VALID' : 'FAILED',
            },
          ]
        : [];
    return send(res, 200, { APIConnect: 'DONE', no_of_trans_found: element.length, element });
  }
  if (path === '/sslcommerz/validator/api/validationserverAPI.php') {
    const valId = url.searchParams.get('val_id');
    const p = [...payments.values()].find((x) => x.valId === valId);
    if (!p || p.state !== 'paid') return send(res, 200, { status: 'INVALID_TRANSACTION' });
    return send(res, 200, {
      status: 'VALID',
      tran_id: p.ref,
      val_id: valId,
      amount: p.amount,
      currency: 'BDT',
      currency_type: 'BDT',
      currency_amount: p.amount,
      bank_tran_id: `SSLTRX${short(p.ref)}`,
      risk_level: '0',
    });
  }

  // ------------------------------------------------------------ aamarPay
  if (path === '/aamarpay/jsonpost.php') {
    const b = json(raw);
    if (
      b.store_id !== KEYS.aamarpay.storeId ||
      b.signature_key !== KEYS.aamarpay.signatureKey ||
      b.type !== 'json'
    )
      return send(res, 200, 'Invalid Store ID or Signature Key');
    const page = addPayment({
      gateway: 'aamarpay',
      ref: b.tran_id,
      sessionId: b.tran_id,
      amount: b.amount,
      success: b.success_url,
      cancel: b.cancel_url,
      description: b.desc,
    });
    return send(res, 200, { result: 'true', payment_url: page });
  }
  if (path === '/aamarpay/api/v1/trxcheck/request.php') {
    const q = url.searchParams;
    const p = payments.get(q.get('request_id') ?? '');
    if (!p || q.get('signature_key') !== KEYS.aamarpay.signatureKey)
      return send(res, 200, { status: 'fail', message: 'Invalid Request' });
    const [pay, code] = {
      open: ['Pending', '1'],
      paid: ['Successful', '2'],
      cancelled: ['Cancelled', '9'],
    }[p.state];
    return send(res, 200, {
      mer_txnid: p.ref,
      pg_txnid: p.state === 'paid' ? `AAM${short(p.ref)}` : null,
      amount: p.amount,
      amount_bdt: p.amount,
      currency: 'BDT',
      currency_merchant: 'BDT',
      pay_status: pay,
      status_code: code,
      status_title: pay,
    });
  }

  // ------------------------------------------------------------ shurjoPay
  if (path === '/shurjopay/api/get_token') {
    const b = json(raw);
    if (b.username !== KEYS.shurjopay.username || b.password !== KEYS.shurjopay.password)
      return send(res, 401, {
        sp_code: '1064',
        message: 'Unauthorized: wrong username or password',
      });
    return send(res, 200, {
      token: 'stand-in-shurjopay-token',
      store_id: 1,
      execute_url: '',
      token_type: 'Bearer',
      sp_code: '200',
      message: 'Ok',
      expires_in: 900,
    });
  }
  if (path === '/shurjopay/api/secret-pay') {
    if (req.headers.authorization !== 'Bearer stand-in-shurjopay-token')
      return send(res, 401, { message: 'Unauthorized' });
    const b = json(raw);
    const sessionId = `${b.prefix}${b.order_id.slice(-10)}`;
    const page = addPayment({
      gateway: 'shurjopay',
      ref: b.order_id,
      sessionId,
      amount: b.amount,
      success: b.return_url,
      cancel: b.cancel_url,
      description: b.customer_name,
    });
    return send(res, 200, {
      checkout_url: page,
      amount: Number(b.amount),
      currency: 'BDT',
      sp_order_id: sessionId,
      customer_order_id: b.order_id,
      customer_name: b.customer_name,
      intent: 'sale',
      transactionStatus: 'Initiated',
    });
  }
  if (path === '/shurjopay/api/verification') {
    const p = bySession(json(raw).order_id);
    if (!p) return send(res, 200, [{ sp_code: '1011', sp_message: 'Invalid Order ID' }]);
    const code = { open: '1068', paid: '1000', cancelled: '1002' }[p.state];
    return send(res, 200, [
      {
        id: 1,
        order_id: p.sessionId,
        customer_order_id: p.ref,
        currency: 'BDT',
        amount: p.amount,
        payable_amount: p.amount,
        received_amount: p.state === 'paid' ? p.amount : '0',
        sp_code: code,
        sp_message: code === '1000' ? 'Success' : 'Not paid',
        bank_trx_id: p.state === 'paid' ? `SPTRX${short(p.ref)}` : null,
        method: 'bKash',
      },
    ]);
  }

  send(res, 404, { error: `unknown endpoint in the payment stand-in: ${path}` });
});

server.listen(PORT, HOST, () => {
  console.log(
    `Payment stand-in (NOT a payment gateway) on http://${HOST}:${PORT}; pages at ${PUBLIC}/pay/<ref>`,
  );
});
