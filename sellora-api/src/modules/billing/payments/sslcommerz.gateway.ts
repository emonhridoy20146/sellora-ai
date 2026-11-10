import { Inject, Injectable } from '@nestjs/common';
import { currencyInfo, toMinor } from '../../../common/money/money.js';
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

/**
 * SSLCommerz hosted checkout (API v4). We create a session, send the payer to the
 * returned GatewayPageURL, and only trust a payment after asking the validation API with
 * the `val_id` SSLCommerz gives us (from the IPN or the browser return).
 */
@Injectable()
export class SslCommerzGateway {
  constructor(
    @Inject(GATEWAY_FETCH) private readonly http: GatewayFetch,
    private readonly config: AppConfig,
  ) {}

  private host(sandbox: boolean) {
    return this.config
      .get(sandbox ? 'PAYMENT_SSLCOMMERZ_SANDBOX_URL' : 'PAYMENT_SSLCOMMERZ_LIVE_URL')
      .replace(/\/$/, '');
  }

  async createCheckout(
    creds: GatewayCredentials['sslcommerz'],
    sandbox: boolean,
    req: CheckoutRequest,
    /** What is sold: Sellora's own billing sells a service; shops sell goods (ADR 0029). */
    goods?: { category: string; address?: string; city?: string },
  ): Promise<CheckoutSession> {
    const form = new URLSearchParams({
      store_id: creds.storeId,
      store_passwd: creds.storePassword,
      total_amount: decimalAmount(req.amountMinor, currencyInfo(req.currency).minorUnits),
      currency: req.currency,
      tran_id: req.paymentId,
      success_url: req.urls.success,
      fail_url: req.urls.fail,
      cancel_url: req.urls.cancel,
      ipn_url: req.urls.notify,
      cus_name: req.customer.name,
      cus_email: req.customer.email ?? 'billing@sellora.ai',
      cus_phone: req.customer.phone ?? '01700000000',
      cus_add1: (goods?.address ?? 'N/A').slice(0, 50) || 'N/A',
      cus_city: (goods?.city ?? 'Dhaka').slice(0, 50) || 'Dhaka',
      cus_country: 'Bangladesh',
      shipping_method: 'NO',
      num_of_item: '1',
      product_name: req.description.slice(0, 250),
      product_category: goods?.category ?? 'SaaS',
      product_profile: goods ? 'physical-goods' : 'non-physical-goods',
      value_a: req.paymentId,
    });
    const res = await this.http(`${this.host(sandbox)}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.status !== 'SUCCESS' || typeof body.GatewayPageURL !== 'string') {
      throw new GatewayError('sslcommerz', 'SSLCommerz did not create a checkout session', {
        httpStatus: res.status,
        reason: body.failedreason ?? null,
      });
    }
    return {
      sessionId: str(body.sessionkey),
      redirectUrl: body.GatewayPageURL,
      raw: { sessionkey: body.sessionkey ?? null },
    };
  }

  /** Asks SSLCommerz whether `valId` is a real, completed payment and for how much. */
  async validate(
    creds: GatewayCredentials['sslcommerz'],
    sandbox: boolean,
    valId: string,
  ): Promise<VerifiedPayment & { tranId?: string }> {
    const url = new URL(`${this.host(sandbox)}/validator/api/validationserverAPI.php`);
    url.search = new URLSearchParams({
      val_id: valId,
      store_id: creds.storeId,
      store_passwd: creds.storePassword,
      v: '1',
      format: 'json',
    }).toString();
    const res = await this.http(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, string | undefined>;
    if (!res.ok)
      throw new GatewayError('sslcommerz', 'SSLCommerz validation failed', {
        httpStatus: res.status,
      });
    const raw = {
      status: body.status,
      tran_id: body.tran_id,
      val_id: body.val_id,
      bank_tran_id: body.bank_tran_id,
      amount: body.amount,
      currency: body.currency,
      currency_type: body.currency_type,
      currency_amount: body.currency_amount,
      risk_level: body.risk_level,
    };
    if (body.status !== 'VALID' && body.status !== 'VALIDATED') {
      return {
        status: 'failed',
        reason: `sslcommerz_${String(body.status ?? 'unknown').toLowerCase()}`,
        raw,
        tranId: body.tran_id,
      };
    }
    // currency_type/currency_amount carry the original currency when SSLCommerz converted it.
    const currency = (body.currency_type ?? body.currency ?? '').toUpperCase();
    const amount = body.currency_amount ?? body.amount ?? '0';
    let amountMinor: number | undefined;
    try {
      amountMinor = toMinor(amount, currency);
    } catch {
      amountMinor = undefined;
    }
    return {
      status: 'succeeded',
      gatewayRef: body.bank_tran_id ?? body.val_id ?? valId,
      ...(amountMinor !== undefined ? { amountMinor } : {}),
      currency,
      raw,
      tranId: body.tran_id,
    };
  }

  /**
   * Looks a payment up by our transaction id (the transaction query API), for payments whose
   * shopper never came back. Answers the `val_id` of a valid payment, if there is one. With
   * a made-up id it also tells whether the store id and password are right.
   */
  async findByTranId(
    creds: GatewayCredentials['sslcommerz'],
    sandbox: boolean,
    tranId: string,
  ): Promise<{ connected: boolean; reason: string; valId?: string; failed: boolean }> {
    const url = new URL(`${this.host(sandbox)}/validator/api/merchantTransIDvalidationAPI.php`);
    url.search = new URLSearchParams({
      tran_id: tranId,
      store_id: creds.storeId,
      store_passwd: creds.storePassword,
      format: 'json',
    }).toString();
    const res = await this.http(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok)
      throw new GatewayError('sslcommerz', 'SSLCommerz transaction query failed', {
        httpStatus: res.status,
      });
    const connect = str(body.APIConnect);
    const elements = Array.isArray(body.element) ? (body.element as Record<string, unknown>[]) : [];
    const valid = elements.find((e) => e.status === 'VALID' || e.status === 'VALIDATED');
    const failed =
      elements.length > 0 &&
      !valid &&
      elements.every((e) => e.status === 'FAILED' || e.status === 'CANCELLED');
    return {
      connected: connect === 'DONE',
      reason: connect || 'no answer',
      ...(valid && typeof valid.val_id === 'string' ? { valId: valid.val_id } : {}),
      failed,
    };
  }
}
