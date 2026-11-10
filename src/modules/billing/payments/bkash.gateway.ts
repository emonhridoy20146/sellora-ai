import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { toMinor } from '../../../common/money/money.js';
import { AppConfig } from '../../../config/app-config.js';
import {
  GATEWAY_FETCH,
  GATEWAY_TIMEOUT_MS,
  GatewayError,
  decimalAmount,
  type CheckoutRequest,
  type CheckoutSession,
  type GatewayCredentials,
  type GatewayFetch,
  type VerifiedPayment,
  str,
} from './gateway.types.js';

type Creds = GatewayCredentials['bkash'];

/**
 * Tokens are cached per full set of credentials, not per app key: many businesses connect
 * their own bKash accounts (ADR 0029), and an app key alone must never reuse another's token.
 */
function tokenKey(creds: Creds, sandbox: boolean): string {
  return createHash('sha256')
    .update(
      JSON.stringify([sandbox, creds.appKey, creds.appSecret, creds.username, creds.password]),
    )
    .digest('hex');
}

/**
 * bKash tokenized checkout. Flow: grant token → create payment (payer is sent to
 * bkashURL) → bKash redirects to our callback with paymentID and status → we call
 * execute, and only an execute (or status query) answer of "Completed" counts as paid.
 */
@Injectable()
export class BkashGateway {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    @Inject(GATEWAY_FETCH) private readonly http: GatewayFetch,
    private readonly config: AppConfig,
  ) {}

  private base(sandbox: boolean) {
    return this.config
      .get(sandbox ? 'PAYMENT_BKASH_SANDBOX_URL' : 'PAYMENT_BKASH_LIVE_URL')
      .replace(/\/$/, '');
  }

  private async call(
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await this.http(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok)
      throw new GatewayError('bkash', 'bKash request failed', {
        httpStatus: res.status,
        statusCode: json.statusCode ?? null,
        message: json.statusMessage ?? json.errorMessage ?? null,
      });
    return json;
  }

  /** Grant tokens are valid for an hour; reuse them instead of granting per request. */
  private async token(creds: Creds, sandbox: boolean): Promise<string> {
    const key = tokenKey(creds, sandbox);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const json = await this.call(
      `${this.base(sandbox)}/tokenized/checkout/token/grant`,
      { username: creds.username, password: creds.password },
      { app_key: creds.appKey, app_secret: creds.appSecret },
    );
    if (typeof json.id_token !== 'string')
      throw new GatewayError('bkash', 'bKash did not grant a token', {
        statusCode: json.statusCode ?? null,
        message: json.statusMessage ?? null,
      });
    const ttl = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    this.tokens.set(key, {
      token: json.id_token,
      expiresAt: Date.now() + Math.max(60, ttl - 120) * 1000,
    });
    return json.id_token;
  }

  /** Whether bKash grants a token for these credentials (checked before they are saved). */
  async check(creds: Creds, sandbox: boolean): Promise<void> {
    this.tokens.delete(tokenKey(creds, sandbox));
    await this.token(creds, sandbox);
  }

  private async authed(creds: Creds, sandbox: boolean, path: string, body: unknown) {
    const token = await this.token(creds, sandbox);
    return this.call(
      `${this.base(sandbox)}${path}`,
      { authorization: token, 'x-app-key': creds.appKey },
      body,
    );
  }

  async createCheckout(
    creds: Creds,
    sandbox: boolean,
    req: CheckoutRequest,
  ): Promise<CheckoutSession> {
    if (req.currency !== 'BDT') throw new GatewayError('bkash', 'bKash only accepts BDT');
    const json = await this.authed(creds, sandbox, '/tokenized/checkout/create', {
      mode: '0011',
      payerReference: req.customer.phone ?? req.paymentId,
      callbackURL: req.urls.success,
      amount: decimalAmount(req.amountMinor),
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: req.paymentId,
    });
    if (
      json.statusCode !== '0000' ||
      typeof json.paymentID !== 'string' ||
      typeof json.bkashURL !== 'string'
    ) {
      throw new GatewayError('bkash', 'bKash did not create the payment', {
        statusCode: json.statusCode ?? null,
        message: json.statusMessage ?? null,
      });
    }
    return {
      sessionId: json.paymentID,
      redirectUrl: json.bkashURL,
      raw: { paymentID: json.paymentID },
    };
  }

  private toVerified(json: Record<string, unknown>): VerifiedPayment & { invoice?: string } {
    const raw = {
      statusCode: json.statusCode,
      transactionStatus: json.transactionStatus,
      trxID: json.trxID,
      amount: json.amount,
      currency: json.currency,
      merchantInvoiceNumber: json.merchantInvoiceNumber,
      paymentID: json.paymentID,
    };
    const invoice =
      typeof json.merchantInvoiceNumber === 'string' ? json.merchantInvoiceNumber : undefined;
    if (
      json.statusCode === '0000' &&
      json.transactionStatus === 'Completed' &&
      typeof json.trxID === 'string'
    ) {
      const currency = str(json.currency, 'BDT').toUpperCase();
      return {
        status: 'succeeded',
        gatewayRef: json.trxID,
        amountMinor: toMinor(str(json.amount, '0'), currency),
        currency,
        raw,
        ...(invoice ? { invoice } : {}),
      };
    }
    if (json.transactionStatus === 'Initiated' || json.transactionStatus === 'Pending Authorized')
      return { status: 'pending', raw, ...(invoice ? { invoice } : {}) };
    return {
      status: 'failed',
      reason: `bkash_${str(json.statusCode) || str(json.transactionStatus, 'unknown')}`,
      raw,
      ...(invoice ? { invoice } : {}),
    };
  }

  /** Completes an authorised payment. Safe to repeat: falls back to a status query. */
  async execute(
    creds: Creds,
    sandbox: boolean,
    paymentID: string,
  ): Promise<VerifiedPayment & { invoice?: string }> {
    try {
      const executed = this.toVerified(
        await this.authed(creds, sandbox, '/tokenized/checkout/execute', { paymentID }),
      );
      if (executed.status === 'succeeded') return executed;
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
    }
    return this.query(creds, sandbox, paymentID);
  }

  async query(
    creds: Creds,
    sandbox: boolean,
    paymentID: string,
  ): Promise<VerifiedPayment & { invoice?: string }> {
    return this.toVerified(
      await this.authed(creds, sandbox, '/tokenized/checkout/payment/status', { paymentID }),
    );
  }
}
