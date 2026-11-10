import {
  constants,
  createPrivateKey,
  createPublicKey,
  createHash,
  createSign,
  privateDecrypt,
  publicEncrypt,
  type KeyObject,
} from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { toMinor } from '../../../common/money/money.js';
import { AppConfig } from '../../../config/app-config.js';
import {
  GATEWAY_FETCH,
  GATEWAY_TIMEOUT_MS,
  GatewayError,
  decimalAmount,
  str,
  type GatewayFetch,
} from '../../billing/payments/gateway.types.js';
import {
  shopGatewayCredentials,
  shopperIpv4,
  type ShopAttempt,
  type ShopGatewayAdapter,
  type ShopGatewayCredentials,
  type ShopStartRequest,
  type ShopStarted,
  type ShopVerified,
} from './shop-gateway.types.js';

type Creds = ShopGatewayCredentials['nagad'];

const API_VERSION = 'v-0.2.0';
/** Nagad's code for Bangladeshi taka. */
const BDT = '050';

/** Keys arrive as PEM or as the bare base64 body Nagad's merchant panel shows. */
function pem(key: string, type: 'PRIVATE' | 'PUBLIC'): string {
  const k = key.trim();
  if (/-----BEGIN/.test(k)) return k;
  const body = k.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [body];
  return `-----BEGIN ${type} KEY-----\n${lines.join('\n')}\n-----END ${type} KEY-----`;
}

function keys(c: Creds): { priv: KeyObject; pub: KeyObject } {
  try {
    const priv = createPrivateKey(pem(c.privateKey, 'PRIVATE'));
    const pub = createPublicKey(pem(c.publicKey, 'PUBLIC'));
    if (priv.asymmetricKeyType !== 'rsa' || pub.asymmetricKeyType !== 'rsa') throw new Error('rsa');
    return { priv, pub };
  } catch {
    throw new GatewayError('nagad', 'The Nagad keys are not readable RSA keys');
  }
}

/** Nagad's clock: Asia/Dhaka (UTC+6, no daylight saving), as yyyyMMddHHmmss. */
function dhakaTimestamp(now = Date.now()): string {
  return new Date(now + 6 * 3_600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * Nagad online payment (check-out API v-0.2.0). Each call's sensitive part is JSON encrypted
 * with Nagad's public key (RSA, PKCS#1 v1.5) and signed with the merchant's private key
 * (SHA-256 with RSA). Flow: initialize (Nagad answers a payment reference and a challenge,
 * encrypted for us) → complete (Nagad answers the page to send the shopper to) → Nagad sends
 * the shopper back with the reference → we ask Nagad's verify API, and only "Success" counts.
 */
@Injectable()
export class NagadGateway implements ShopGatewayAdapter<Creds> {
  readonly descriptor = {
    key: 'nagad' as const,
    name: 'Nagad',
    shopperHint: 'Pay with your Nagad account',
    fields: [
      { key: 'merchantId', label: 'Merchant ID', secret: false },
      {
        key: 'merchantNumber',
        label: 'Merchant number',
        secret: false,
        placeholder: '01XXXXXXXXX',
      },
      { key: 'privateKey', label: 'Merchant private key', secret: true, multiline: true },
      { key: 'publicKey', label: 'Nagad public key', secret: true, multiline: true },
    ],
    checkable: false,
    help: 'From the Nagad merchant panel: your merchant ID and number, the private key you generated and Nagad’s payment gateway public key.',
  };
  readonly credentials = shopGatewayCredentials.nagad;

  constructor(
    @Inject(GATEWAY_FETCH) private readonly http: GatewayFetch,
    private readonly config: AppConfig,
  ) {}

  hint(c: Creds): string {
    return `Merchant ${c.merchantId}`;
  }

  private base(sandbox: boolean) {
    return `${this.config
      .get(sandbox ? 'PAYMENT_NAGAD_SANDBOX_URL' : 'PAYMENT_NAGAD_LIVE_URL')
      .replace(/\/$/, '')}/api/dfs`;
  }

  check(c: Creds): Promise<{ checked: boolean; summary: string }> {
    keys(c);
    return Promise.resolve({
      checked: false,
      summary: 'The keys are readable. Nagad confirms them on the first payment.',
    });
  }

  private encrypt(pub: KeyObject, data: unknown): string {
    return publicEncrypt(
      { key: pub, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(JSON.stringify(data)),
    ).toString('base64');
  }

  private sign(priv: KeyObject, data: unknown): string {
    const s = createSign('SHA256');
    s.update(JSON.stringify(data));
    s.end();
    return s.sign(priv, 'base64');
  }

  private decrypt(priv: KeyObject, data: string): Record<string, unknown> {
    try {
      return JSON.parse(
        privateDecrypt(
          { key: priv, padding: constants.RSA_PKCS1_PADDING },
          Buffer.from(data, 'base64'),
        ).toString('utf8'),
      ) as Record<string, unknown>;
    } catch {
      throw new GatewayError('nagad', 'Could not read Nagad’s answer with the merchant key');
    }
  }

  private async call(
    method: 'GET' | 'POST',
    url: string,
    ip: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await this.http(url, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-KM-Api-Version': API_VERSION,
        'X-KM-IP-V4': ip,
        'X-KM-Client-Type': 'PC_WEB',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.reason || json.devMessage)
      throw new GatewayError('nagad', str(json.message, 'Nagad refused the request'), {
        httpStatus: res.status,
        reason: json.reason ?? null,
      });
    return json;
  }

  async start(c: Creds, sandbox: boolean, req: ShopStartRequest): Promise<ShopStarted> {
    if (req.currency !== 'BDT') throw new GatewayError('nagad', 'Nagad only accepts BDT');
    const { priv, pub } = keys(c);
    const ip = shopperIpv4(req.shopperIp);
    const datetime = dhakaTimestamp();
    const init = {
      merchantId: c.merchantId,
      datetime,
      orderId: req.ref,
      challenge: createHash('sha1').update(req.ref).digest('hex').toUpperCase(),
    };
    const initialized = await this.call(
      'POST',
      `${this.base(sandbox)}/check-out/initialize/${c.merchantId}/${req.ref}?locale=EN`,
      ip,
      {
        accountNumber: c.merchantNumber,
        dateTime: datetime,
        sensitiveData: this.encrypt(pub, init),
        signature: this.sign(priv, init),
      },
    );
    if (typeof initialized.sensitiveData !== 'string')
      throw new GatewayError('nagad', 'Nagad did not start the payment');
    const answer = this.decrypt(priv, initialized.sensitiveData);
    const paymentReferenceId = str(answer.paymentReferenceId);
    const challenge = str(answer.challenge);
    if (!paymentReferenceId || !challenge)
      throw new GatewayError('nagad', 'Nagad did not give a payment reference');
    const order = {
      merchantId: c.merchantId,
      orderId: req.ref,
      currencyCode: BDT,
      amount: decimalAmount(req.amountMinor),
      challenge,
    };
    const completed = await this.call(
      'POST',
      `${this.base(sandbox)}/check-out/complete/${paymentReferenceId}`,
      ip,
      {
        paymentRefId: paymentReferenceId,
        sensitiveData: this.encrypt(pub, order),
        signature: this.sign(priv, order),
        merchantCallbackURL: req.returnUrl('done'),
        additionalMerchantInfo: { productDetails: req.description.slice(0, 100) },
      },
    );
    if (completed.status !== 'Success' || typeof completed.callBackUrl !== 'string')
      throw new GatewayError(
        'nagad',
        str(completed.message, 'Nagad did not open the payment page'),
      );
    return { sessionId: paymentReferenceId, redirectUrl: completed.callBackUrl };
  }

  private async verify(sandbox: boolean, paymentRefId: string): Promise<ShopVerified> {
    const json = await this.call(
      'GET',
      `${this.base(sandbox)}/verify/payment/${encodeURIComponent(paymentRefId)}`,
      '127.0.0.1',
    );
    const raw = {
      status: json.status ?? null,
      statusCode: json.statusCode ?? null,
      orderId: json.orderId ?? null,
      amount: json.amount ?? null,
      issuerPaymentRefNo: json.issuerPaymentRefNo ?? null,
    };
    const status = str(json.status);
    const ref = str(json.orderId) || undefined;
    if (status === 'Success' && str(json.statusCode) === '000') {
      let amountMinor: number | undefined;
      try {
        amountMinor = toMinor(str(json.amount, '0'), 'BDT');
      } catch {
        amountMinor = undefined;
      }
      return {
        status: 'succeeded',
        settled: true,
        gatewayRef: str(json.issuerPaymentRefNo) || paymentRefId,
        ...(amountMinor !== undefined ? { amountMinor } : {}),
        currency: 'BDT',
        ...(ref ? { ref } : {}),
        raw,
      };
    }
    if (['Aborted', 'Cancelled'].includes(status))
      return { status: 'cancelled', settled: true, reason: `nagad_${status.toLowerCase()}`, raw };
    if (['Failed', 'Rejected', 'Expired', 'Unknown'].includes(status))
      return { status: 'failed', settled: true, reason: `nagad_${status.toLowerCase()}`, raw };
    return { status: 'pending', settled: false, raw };
  }

  complete(
    _c: Creds,
    sandbox: boolean,
    attempt: ShopAttempt,
    _outcome: string,
    params: Record<string, string>,
  ): Promise<ShopVerified> {
    // Nagad sends payment_ref_id back; only the reference we started with is asked about.
    if (
      !attempt.sessionId ||
      (params.payment_ref_id && params.payment_ref_id !== attempt.sessionId)
    )
      return Promise.resolve({ status: 'failed', settled: false, reason: 'nagad_wrong_reference' });
    return this.verify(sandbox, attempt.sessionId);
  }

  lookup(_c: Creds, sandbox: boolean, attempt: ShopAttempt): Promise<ShopVerified> {
    if (!attempt.sessionId) return Promise.resolve({ status: 'pending', settled: false });
    return this.verify(sandbox, attempt.sessionId);
  }
}

export const nagadTesting = { pem, dhakaTimestamp };
