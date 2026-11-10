import {
  constants,
  createSign,
  createVerify,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  type KeyObject,
} from 'node:crypto';
import type { GatewayFetch } from '../../src/modules/billing/payments/gateway.types.js';

type Gateway = 'bkash' | 'nagad' | 'sslcommerz' | 'aamarpay' | 'shurjopay';

interface Attempt {
  gateway: Gateway;
  ref: string;
  sessionId: string;
  amount: string;
  /** What the shopper did at the gateway. */
  state: 'open' | 'paid' | 'cancelled' | 'failed';
  /** A different amount the gateway reports (to test mismatches). */
  reportedAmount?: string;
  valId?: string;
}

const privatePem = (k: KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = (k: KeyObject) => k.export({ type: 'spki', format: 'pem' }).toString();

/**
 * Plays bKash, Nagad, SSLCommerz, aamarPay and shurjoPay for shop payment tests (ADR 0029).
 * It answers the documented endpoints with the documented response shapes, checks Nagad's
 * encryption and signatures with real RSA keys, and records what it was asked. This proves our
 * side of each contract as documented; it does not prove the real gateways behave so.
 */
export class FakeShopGateways {
  readonly calls: { url: string; method: string; body: string; headers: Record<string, string> }[] =
    [];
  readonly attempts = new Map<string, Attempt>();
  /** The next payment start answers a server error. */
  failNextStart = false;

  // Nagad: the merchant's key pair (the merchant keeps the private one) and Nagad's own.
  private readonly merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly nagad = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly nagadChallenges = new Map<string, { ref: string; challenge: string }>();

  /** Keys a business pastes into Settings › Payments for each gateway. */
  readonly credentials = {
    bkash: {
      appKey: 'bk-app-key-0001',
      appSecret: 'bk-secret',
      username: 'shop01',
      password: 'pw',
    },
    nagad: {
      merchantId: '683002007104225',
      merchantNumber: '01711428036',
      privateKey: privatePem(this.merchant.privateKey),
      publicKey: publicPem(this.nagad.publicKey),
    },
    sslcommerz: { storeId: 'shop5f0c1e', storePassword: 'shop5f0c1e@ssl' },
    aamarpay: { storeId: 'aamarpaytest', signatureKey: 'dbb74894e82415a2f7ff0ec3a97e4183' },
    shurjopay: { username: 'sp_sandbox', password: 'sp-pass', prefix: 'NOK' },
  } as const;

  readonly fetch: GatewayFetch = (input, init) => Promise.resolve(this.handle(input, init));

  /** The shopper pays at the gateway (optionally the gateway reports another amount). */
  pay(ref: string, reportedAmount?: string): Attempt {
    const a = this.attempts.get(ref);
    if (!a) throw new Error(`no attempt ${ref}`);
    a.state = 'paid';
    if (reportedAmount) a.reportedAmount = reportedAmount;
    a.valId = `VAL${ref}`;
    return a;
  }

  cancel(ref: string): Attempt {
    const a = this.attempts.get(ref)!;
    a.state = 'cancelled';
    return a;
  }

  /** The latest attempt started with a gateway. */
  last(gateway: Gateway): Attempt {
    const list = [...this.attempts.values()].filter((a) => a.gateway === gateway);
    const a = list[list.length - 1];
    if (!a) throw new Error(`no ${gateway} attempt`);
    return a;
  }

  private handle(input: Parameters<GatewayFetch>[0], init: Parameters<GatewayFetch>[1]): Response {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    this.calls.push({ url, method: init?.method ?? 'GET', body, headers });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const path = new URL(url).pathname;
    const isStart =
      path.endsWith('/tokenized/checkout/create') ||
      path.includes('/check-out/initialize/') ||
      path.endsWith('/gwprocess/v4/api.php') ||
      path.endsWith('/jsonpost.php') ||
      path.endsWith('/secret-pay');
    if (this.failNextStart && isStart) {
      this.failNextStart = false;
      return json(503, {
        status: 'FAILED',
        failedreason: 'maintenance',
        message: 'Service unavailable',
      });
    }

    // ---------------------------------------------------------------- bKash
    if (path.endsWith('/tokenized/checkout/token/grant')) {
      const b = JSON.parse(body) as { app_key: string; app_secret: string };
      if (
        b.app_key !== this.credentials.bkash.appKey ||
        b.app_secret !== this.credentials.bkash.appSecret
      )
        return json(401, { statusCode: '2079', statusMessage: 'Invalid app key or secret' });
      return json(200, { statusCode: '0000', id_token: 'bk-token', expires_in: 3600 });
    }
    if (path.endsWith('/tokenized/checkout/create')) {
      const b = JSON.parse(body) as { amount: string; merchantInvoiceNumber: string };
      const sessionId = `BK${b.merchantInvoiceNumber}`;
      this.attempts.set(b.merchantInvoiceNumber, {
        gateway: 'bkash',
        ref: b.merchantInvoiceNumber,
        sessionId,
        amount: b.amount,
        state: 'open',
      });
      return json(200, {
        statusCode: '0000',
        paymentID: sessionId,
        bkashURL: `https://sandbox.payment.bkash.com/?paymentId=${sessionId}`,
      });
    }
    if (
      path.endsWith('/tokenized/checkout/execute') ||
      path.endsWith('/tokenized/checkout/payment/status')
    ) {
      const { paymentID } = JSON.parse(body) as { paymentID: string };
      const a = [...this.attempts.values()].find((x) => x.sessionId === paymentID);
      if (!a) return json(200, { statusCode: '2056', statusMessage: 'Invalid Payment State' });
      if (a.state !== 'paid')
        return json(200, {
          statusCode: '0000',
          paymentID,
          transactionStatus: a.state === 'open' ? 'Initiated' : 'Failed',
          merchantInvoiceNumber: a.ref,
          amount: a.amount,
          currency: 'BDT',
        });
      return json(200, {
        statusCode: '0000',
        paymentID,
        trxID: `TRX${a.ref.slice(-6)}`,
        transactionStatus: 'Completed',
        amount: a.reportedAmount ?? a.amount,
        currency: 'BDT',
        merchantInvoiceNumber: a.ref,
      });
    }

    // ---------------------------------------------------------------- Nagad
    if (path.includes('/api/dfs/check-out/initialize/')) {
      const b = JSON.parse(body) as {
        sensitiveData: string;
        signature: string;
        accountNumber: string;
      };
      const plain = privateDecrypt(
        { key: this.nagad.privateKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(b.sensitiveData, 'base64'),
      ).toString();
      const ok = createVerify('SHA256')
        .update(plain)
        .verify(this.merchant.publicKey, b.signature, 'base64');
      const data = JSON.parse(plain) as { merchantId: string; orderId: string; challenge: string };
      if (!ok || data.merchantId !== this.credentials.nagad.merchantId)
        return json(400, { reason: 'INVALID_SIGNATURE', message: 'Signature does not match' });
      const paymentReferenceId = `NG${data.orderId}`;
      const challenge = `CH${data.orderId.slice(-6)}`;
      this.nagadChallenges.set(paymentReferenceId, { ref: data.orderId, challenge });
      const answer = JSON.stringify({
        paymentReferenceId,
        challenge,
        acceptDateTime: '20261110120000',
      });
      return json(200, {
        sensitiveData: publicEncrypt(
          { key: this.merchant.publicKey, padding: constants.RSA_PKCS1_PADDING },
          Buffer.from(answer),
        ).toString('base64'),
        signature: createSign('SHA256').update(answer).sign(this.nagad.privateKey, 'base64'),
      });
    }
    if (path.includes('/api/dfs/check-out/complete/')) {
      const ref = path.split('/').pop()!;
      const b = JSON.parse(body) as {
        sensitiveData: string;
        signature: string;
        merchantCallbackURL: string;
      };
      const plain = privateDecrypt(
        { key: this.nagad.privateKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(b.sensitiveData, 'base64'),
      ).toString();
      const data = JSON.parse(plain) as {
        orderId: string;
        amount: string;
        challenge: string;
        currencyCode: string;
      };
      const ok = createVerify('SHA256')
        .update(plain)
        .verify(this.merchant.publicKey, b.signature, 'base64');
      const known = this.nagadChallenges.get(ref);
      if (!ok || !known || known.challenge !== data.challenge || data.currencyCode !== '050')
        return json(400, { reason: 'INVALID_REQUEST', message: 'Challenge does not match' });
      this.attempts.set(data.orderId, {
        gateway: 'nagad',
        ref: data.orderId,
        sessionId: ref,
        amount: data.amount,
        state: 'open',
      });
      return json(200, {
        status: 'Success',
        callBackUrl: `https://sandbox-ssl.mynagad.com/check-out/${ref}`,
      });
    }
    if (path.includes('/api/dfs/verify/payment/')) {
      const sid = decodeURIComponent(path.split('/').pop()!);
      const a = [...this.attempts.values()].find((x) => x.sessionId === sid);
      if (!a) return json(200, { status: 'Unknown', statusCode: '404' });
      const status = { open: 'Ready', paid: 'Success', cancelled: 'Aborted', failed: 'Failed' }[
        a.state
      ];
      return json(200, {
        merchantId: this.credentials.nagad.merchantId,
        orderId: a.ref,
        paymentRefId: sid,
        amount: a.reportedAmount ?? a.amount,
        status,
        statusCode: a.state === 'paid' ? '000' : '001',
        issuerPaymentRefNo: a.state === 'paid' ? `NGTRX${a.ref.slice(-6)}` : null,
      });
    }

    // ---------------------------------------------------------------- SSLCommerz
    if (path.endsWith('/gwprocess/v4/api.php')) {
      const form = new URLSearchParams(body);
      if (form.get('store_id') !== this.credentials.sslcommerz.storeId)
        return json(200, {
          status: 'FAILED',
          failedreason: 'Store Credential Error Or Store is De-active',
        });
      const ref = form.get('tran_id')!;
      this.attempts.set(ref, {
        gateway: 'sslcommerz',
        ref,
        sessionId: `SK${ref}`,
        amount: form.get('total_amount')!,
        state: 'open',
      });
      return json(200, {
        status: 'SUCCESS',
        sessionkey: `SK${ref}`,
        GatewayPageURL: `https://sandbox.sslcommerz.com/EasyCheckOut/${ref}`,
      });
    }
    if (path.endsWith('/validator/api/merchantTransIDvalidationAPI.php')) {
      const q = new URL(url).searchParams;
      if (
        q.get('store_id') !== this.credentials.sslcommerz.storeId ||
        q.get('store_passwd') !== this.credentials.sslcommerz.storePassword
      )
        return json(200, { APIConnect: 'INVALID_REQUEST' });
      const a = this.attempts.get(q.get('tran_id')!);
      const element =
        a && a.state !== 'open'
          ? [
              {
                tran_id: a.ref,
                val_id: a.valId ?? null,
                status: a.state === 'paid' ? 'VALID' : 'FAILED',
                amount: a.amount,
              },
            ]
          : [];
      return json(200, { APIConnect: 'DONE', no_of_trans_found: element.length, element });
    }
    if (path.endsWith('/validator/api/validationserverAPI.php')) {
      const valId = new URL(url).searchParams.get('val_id')!;
      const a = [...this.attempts.values()].find(
        (x) => x.valId === valId && x.gateway === 'sslcommerz',
      );
      if (!a || a.state !== 'paid') return json(200, { status: 'INVALID_TRANSACTION' });
      const amount = a.reportedAmount ?? a.amount;
      return json(200, {
        status: 'VALID',
        tran_id: a.ref,
        val_id: valId,
        amount,
        currency: 'BDT',
        bank_tran_id: `BANK${a.ref.slice(-6)}`,
        currency_type: 'BDT',
        currency_amount: amount,
      });
    }

    // ---------------------------------------------------------------- aamarPay
    if (path.endsWith('/jsonpost.php')) {
      const b = JSON.parse(body) as Record<string, string>;
      if (b.store_id !== this.credentials.aamarpay.storeId || b.type !== 'json')
        return json(200, 'Invalid Store ID');
      this.attempts.set(b.tran_id!, {
        gateway: 'aamarpay',
        ref: b.tran_id!,
        sessionId: b.tran_id!,
        amount: b.amount!,
        state: 'open',
      });
      return json(200, {
        result: 'true',
        payment_url: `https://sandbox.aamarpay.com/paynow.php?track=AAM${b.tran_id}`,
      });
    }
    if (path.endsWith('/api/v1/trxcheck/request.php')) {
      const q = new URL(url).searchParams;
      const a = this.attempts.get(q.get('request_id')!);
      if (!a || q.get('signature_key') !== this.credentials.aamarpay.signatureKey)
        return json(200, { status: 'fail', message: 'Invalid Request' });
      const pay = {
        open: ['Pending', '1'],
        paid: ['Successful', '2'],
        cancelled: ['Cancelled', '9'],
        failed: ['Failed', '7'],
      }[a.state];
      return json(200, {
        mer_txnid: a.ref,
        pg_txnid: a.state === 'paid' ? `AAM${a.ref.slice(-6)}` : null,
        amount: a.reportedAmount ?? a.amount,
        amount_bdt: a.amount,
        currency: 'BDT',
        currency_merchant: 'BDT',
        pay_status: pay[0],
        status_code: pay[1],
      });
    }

    // ---------------------------------------------------------------- shurjoPay
    if (path.endsWith('/api/get_token')) {
      const b = JSON.parse(body) as { username: string; password: string };
      if (
        b.username !== this.credentials.shurjopay.username ||
        b.password !== this.credentials.shurjopay.password
      )
        return json(401, { sp_code: '1064', message: 'Unauthorized' });
      return json(200, {
        token: 'sp-token',
        token_type: 'Bearer',
        store_id: 1,
        sp_code: '200',
        expires_in: 900,
      });
    }
    if (path.endsWith('/api/secret-pay')) {
      if (headers.authorization !== 'Bearer sp-token')
        return json(401, { message: 'Unauthorized' });
      const b = JSON.parse(body) as Record<string, string>;
      const sessionId = `${b.prefix}${b.order_id!.slice(-8)}`;
      this.attempts.set(b.order_id!, {
        gateway: 'shurjopay',
        ref: b.order_id!,
        sessionId,
        amount: b.amount!,
        state: 'open',
      });
      return json(200, {
        checkout_url: `https://sandbox.securepay.shurjopayment.com/spaycheckout/?order_id=${sessionId}`,
        sp_order_id: sessionId,
        customer_order_id: b.order_id,
        amount: Number(b.amount),
        currency: 'BDT',
        transactionStatus: 'Initiated',
      });
    }
    if (path.endsWith('/api/verification')) {
      const { order_id } = JSON.parse(body) as { order_id: string };
      const a = [...this.attempts.values()].find((x) => x.sessionId === order_id);
      if (!a) return json(200, [{ sp_code: '1011', sp_message: 'Invalid Order ID' }]);
      const code = { open: '1068', paid: '1000', cancelled: '1002', failed: '1001' }[a.state];
      return json(200, [
        {
          id: 1,
          order_id,
          customer_order_id: a.ref,
          currency: 'BDT',
          amount: a.reportedAmount ?? a.amount,
          sp_code: code,
          sp_message: code === '1000' ? 'Success' : 'Not paid',
          bank_trx_id: a.state === 'paid' ? `SPTRX${a.ref.slice(-6)}` : null,
          method: 'bKash',
        },
      ]);
    }
    return json(404, { error: `unknown endpoint in fake shop gateways: ${path}` });
  }
}
