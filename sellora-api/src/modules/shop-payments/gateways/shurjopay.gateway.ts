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
  credentialKey,
  shopGatewayCredentials,
  shopperEmail,
  type ShopAttempt,
  type ShopGatewayAdapter,
  type ShopGatewayCredentials,
  type ShopStartRequest,
  type ShopStarted,
  type ShopVerified,
} from './shop-gateway.types.js';

type Creds = ShopGatewayCredentials['shurjopay'];

/**
 * shurjoPay v2. Flow: get a token (username and password) → secret-pay (shurjoPay answers
 * its order id and a checkout page) → shurjoPay sends the shopper back with `order_id` →
 * we ask the verification API with the order id we got at the start, and only sp_code 1000
 * counts.
 */
@Injectable()
export class ShurjoPayGateway implements ShopGatewayAdapter<Creds> {
  readonly descriptor = {
    key: 'shurjopay' as const,
    name: 'shurjoPay',
    shopperHint: 'Card, bKash, Nagad, Rocket and more',
    fields: [
      { key: 'username', label: 'Username', secret: false },
      { key: 'password', label: 'Password', secret: true },
      { key: 'prefix', label: 'Order prefix', secret: false, placeholder: 'NOK' },
    ],
    checkable: true,
    help: 'The API username, password and order prefix shurjoPay gave you for your store.',
  };
  readonly credentials = shopGatewayCredentials.shurjopay;
  private readonly tokens = new Map<
    string,
    { token: string; storeId: string; expiresAt: number }
  >();

  constructor(
    @Inject(GATEWAY_FETCH) private readonly http: GatewayFetch,
    private readonly config: AppConfig,
  ) {}

  hint(c: Creds): string {
    return `${c.username} · prefix ${c.prefix}`;
  }

  private base(sandbox: boolean) {
    return `${this.config
      .get(sandbox ? 'PAYMENT_SHURJOPAY_SANDBOX_URL' : 'PAYMENT_SHURJOPAY_LIVE_URL')
      .replace(/\/$/, '')}/api`;
  }

  private async post(url: string, body: unknown, token?: string): Promise<unknown> {
    const res = await this.http(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const o = (json ?? {}) as Record<string, unknown>;
      throw new GatewayError('shurjopay', str(o.message, 'shurjoPay refused the request'), {
        httpStatus: res.status,
        spCode: o.sp_code ?? null,
      });
    }
    return json;
  }

  /** Tokens last a short while; reuse one per set of credentials until shortly before. */
  private async token(c: Creds, sandbox: boolean, fresh = false) {
    const key = credentialKey(sandbox, [c.username, c.password]);
    const cached = this.tokens.get(key);
    if (!fresh && cached && cached.expiresAt > Date.now()) return cached;
    const json = (await this.post(`${this.base(sandbox)}/get_token`, {
      username: c.username,
      password: c.password,
    })) as Record<string, unknown>;
    if (typeof json.token !== 'string' || !json.token)
      throw new GatewayError('shurjopay', str(json.message, 'shurjoPay did not give a token'), {
        spCode: json.sp_code ?? null,
      });
    const ttl = Number(json.expires_in) > 0 ? Number(json.expires_in) : 900;
    const entry = {
      token: json.token,
      storeId: str(json.store_id),
      expiresAt: Date.now() + Math.max(60, Math.min(ttl, 900) - 60) * 1000,
    };
    this.tokens.set(key, entry);
    return entry;
  }

  async check(c: Creds, sandbox: boolean): Promise<{ checked: boolean; summary: string }> {
    const t = await this.token(c, sandbox, true);
    return { checked: true, summary: `shurjoPay accepted the login (store ${t.storeId || '—'}).` };
  }

  async start(c: Creds, sandbox: boolean, req: ShopStartRequest): Promise<ShopStarted> {
    if (req.currency !== 'BDT')
      throw new GatewayError('shurjopay', 'Only BDT orders are supported');
    const t = await this.token(c, sandbox);
    const json = (await this.post(
      `${this.base(sandbox)}/secret-pay`,
      {
        prefix: c.prefix,
        token: t.token,
        store_id: t.storeId,
        return_url: req.returnUrl('done'),
        cancel_url: req.returnUrl('cancel'),
        amount: decimalAmount(req.amountMinor),
        order_id: req.ref,
        currency: 'BDT',
        customer_name: req.customer.name.slice(0, 80),
        customer_address: req.customer.address.slice(0, 100),
        customer_email: shopperEmail(req.customer.email, req.customer.phone),
        customer_phone: req.customer.phone,
        customer_city: (req.customer.city ?? '').slice(0, 50) || 'Dhaka',
        customer_country: 'Bangladesh',
        client_ip: req.shopperIp ?? '127.0.0.1',
        value1: req.ref,
      },
      t.token,
    )) as Record<string, unknown>;
    if (typeof json.checkout_url !== 'string' || typeof json.sp_order_id !== 'string')
      throw new GatewayError(
        'shurjopay',
        str(json.message, 'shurjoPay did not start the payment'),
        {
          spCode: json.sp_code ?? null,
        },
      );
    return { sessionId: json.sp_order_id, redirectUrl: json.checkout_url };
  }

  private async verify(c: Creds, sandbox: boolean, spOrderId: string): Promise<ShopVerified> {
    const t = await this.token(c, sandbox);
    const json = await this.post(
      `${this.base(sandbox)}/verification`,
      { order_id: spOrderId },
      t.token,
    );
    const row = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | undefined;
    if (!row || typeof row !== 'object') return { status: 'pending', settled: false };
    const code = str(row.sp_code);
    const raw = {
      sp_code: row.sp_code ?? null,
      sp_message: row.sp_message ?? null,
      order_id: row.order_id ?? null,
      customer_order_id: row.customer_order_id ?? null,
      amount: row.amount ?? null,
      currency: row.currency ?? null,
      bank_trx_id: row.bank_trx_id ?? null,
      method: row.method ?? null,
    };
    const ref = str(row.customer_order_id) || undefined;
    if (code === '1000') {
      const currency = (str(row.currency) || 'BDT').toUpperCase();
      let amountMinor: number | undefined;
      try {
        amountMinor = toMinor(str(row.amount, '0'), currency);
      } catch {
        amountMinor = undefined;
      }
      return {
        status: 'succeeded',
        settled: true,
        gatewayRef: str(row.bank_trx_id) || spOrderId,
        ...(amountMinor !== undefined ? { amountMinor } : {}),
        currency,
        ...(ref ? { ref } : {}),
        raw,
      };
    }
    if (code === '1002')
      return { status: 'cancelled', settled: true, reason: 'shurjopay_1002', raw };
    if (code === '1001')
      return { status: 'failed', settled: true, reason: `shurjopay_${code}`, raw };
    return { status: 'pending', settled: false, raw };
  }

  complete(
    c: Creds,
    sandbox: boolean,
    attempt: ShopAttempt,
    _outcome: string,
    params: Record<string, string>,
  ): Promise<ShopVerified> {
    if (!attempt.sessionId || (params.order_id && params.order_id !== attempt.sessionId))
      return Promise.resolve({ status: 'failed', settled: false, reason: 'shurjopay_wrong_order' });
    return this.verify(c, sandbox, attempt.sessionId);
  }

  lookup(c: Creds, sandbox: boolean, attempt: ShopAttempt): Promise<ShopVerified> {
    if (!attempt.sessionId) return Promise.resolve({ status: 'pending', settled: false });
    return this.verify(c, sandbox, attempt.sessionId);
  }
}
