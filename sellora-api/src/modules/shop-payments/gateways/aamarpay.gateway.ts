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
  mask,
  shopGatewayCredentials,
  shopperEmail,
  type ShopAttempt,
  type ShopGatewayAdapter,
  type ShopGatewayCredentials,
  type ShopStartRequest,
  type ShopStarted,
  type ShopVerified,
} from './shop-gateway.types.js';

type Creds = ShopGatewayCredentials['aamarpay'];

/**
 * aamarPay JSON checkout. We post the payment to jsonpost.php and send the shopper to the
 * `payment_url` it answers. aamarPay posts the result to our success or fail address, which
 * we never trust: we ask the transaction check API (trxcheck) with our transaction id, and
 * only pay_status "Successful" (status_code 2) counts.
 */
@Injectable()
export class AamarPayGateway implements ShopGatewayAdapter<Creds> {
  readonly descriptor = {
    key: 'aamarpay' as const,
    name: 'aamarPay',
    shopperHint: 'Card, bKash, Nagad, Rocket and more',
    fields: [
      { key: 'storeId', label: 'Store ID', secret: false },
      { key: 'signatureKey', label: 'Signature key', secret: true },
    ],
    checkable: false,
    help: 'The store ID and signature key aamarPay gave you. aamarPay has no way to check them before a payment, so try one sandbox payment first.',
  };
  readonly credentials = shopGatewayCredentials.aamarpay;

  constructor(
    @Inject(GATEWAY_FETCH) private readonly http: GatewayFetch,
    private readonly config: AppConfig,
  ) {}

  hint(c: Creds): string {
    return `Store ${c.storeId} · key ${mask(c.signatureKey)}`;
  }

  private base(sandbox: boolean) {
    return this.config
      .get(sandbox ? 'PAYMENT_AAMARPAY_SANDBOX_URL' : 'PAYMENT_AAMARPAY_LIVE_URL')
      .replace(/\/$/, '');
  }

  check(): Promise<{ checked: boolean; summary: string }> {
    return Promise.resolve({
      checked: false,
      summary: 'aamarPay confirms these keys on the first payment.',
    });
  }

  async start(c: Creds, sandbox: boolean, req: ShopStartRequest): Promise<ShopStarted> {
    if (req.currency !== 'BDT') throw new GatewayError('aamarpay', 'Only BDT orders are supported');
    const res = await this.http(`${this.base(sandbox)}/jsonpost.php`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        store_id: c.storeId,
        signature_key: c.signatureKey,
        tran_id: req.ref,
        amount: decimalAmount(req.amountMinor),
        currency: 'BDT',
        desc: req.description.slice(0, 200),
        cus_name: req.customer.name.slice(0, 80),
        cus_email: shopperEmail(req.customer.email, req.customer.phone),
        cus_phone: req.customer.phone,
        cus_add1: req.customer.address.slice(0, 100),
        cus_city: (req.customer.city ?? '').slice(0, 50) || 'Dhaka',
        cus_country: 'Bangladesh',
        success_url: req.returnUrl('success'),
        fail_url: req.returnUrl('fail'),
        cancel_url: req.returnUrl('cancel'),
        opt_a: req.ref,
        type: 'json',
      }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | string | null;
    const ok =
      res.ok &&
      body !== null &&
      typeof body === 'object' &&
      str(body.result) === 'true' &&
      typeof body.payment_url === 'string';
    if (!ok)
      throw new GatewayError('aamarpay', 'aamarPay did not start the payment', {
        httpStatus: res.status,
        reason: typeof body === 'string' ? body.slice(0, 200) : null,
      });
    return { sessionId: req.ref, redirectUrl: (body as { payment_url: string }).payment_url };
  }

  private async transaction(c: Creds, sandbox: boolean, ref: string): Promise<ShopVerified> {
    const url = new URL(`${this.base(sandbox)}/api/v1/trxcheck/request.php`);
    url.search = new URLSearchParams({
      request_id: ref,
      store_id: c.storeId,
      signature_key: c.signatureKey,
      type: 'json',
    }).toString();
    const res = await this.http(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok)
      throw new GatewayError('aamarpay', 'aamarPay transaction check failed', {
        httpStatus: res.status,
      });
    const raw = {
      pay_status: body.pay_status ?? null,
      status_code: body.status_code ?? null,
      mer_txnid: body.mer_txnid ?? null,
      pg_txnid: body.pg_txnid ?? null,
      amount: body.amount ?? null,
      currency: body.currency_merchant ?? body.currency ?? null,
    };
    const payStatus = str(body.pay_status);
    const ref_ = str(body.mer_txnid) || undefined;
    if (payStatus === 'Successful' && str(body.status_code) === '2') {
      const currency = (str(body.currency_merchant) || str(body.currency) || 'BDT').toUpperCase();
      let amountMinor: number | undefined;
      try {
        amountMinor = toMinor(str(body.amount, '0'), currency);
      } catch {
        amountMinor = undefined;
      }
      return {
        status: 'succeeded',
        settled: true,
        gatewayRef: str(body.pg_txnid) || str(body.bank_trxid) || ref,
        ...(amountMinor !== undefined ? { amountMinor } : {}),
        currency,
        ...(ref_ ? { ref: ref_ } : {}),
        raw,
      };
    }
    if (/^fail/i.test(payStatus) || str(body.status_code) === '7')
      return { status: 'failed', settled: true, reason: 'aamarpay_failed', raw };
    if (/cancel/i.test(payStatus))
      return { status: 'cancelled', settled: true, reason: 'aamarpay_cancelled', raw };
    return { status: 'pending', settled: false, raw };
  }

  complete(
    c: Creds,
    sandbox: boolean,
    attempt: ShopAttempt,
    outcome: string,
  ): Promise<ShopVerified> {
    // aamarPay sends nothing to the cancel address; the worker's check settles it later.
    if (outcome === 'cancel')
      return Promise.resolve({ status: 'cancelled', settled: false, reason: 'shopper_cancelled' });
    return this.transaction(c, sandbox, attempt.ref);
  }

  lookup(c: Creds, sandbox: boolean, attempt: ShopAttempt): Promise<ShopVerified> {
    return this.transaction(c, sandbox, attempt.ref);
  }
}
