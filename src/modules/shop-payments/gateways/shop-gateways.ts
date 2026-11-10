import { Injectable } from '@nestjs/common';
import type { ShopGatewayKey } from '../../commerce/schemas.js';
import { BkashGateway } from '../../billing/payments/bkash.gateway.js';
import { GatewayError } from '../../billing/payments/gateway.types.js';
import { SslCommerzGateway } from '../../billing/payments/sslcommerz.gateway.js';
import { AamarPayGateway } from './aamarpay.gateway.js';
import { NagadGateway } from './nagad.gateway.js';
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
import { ShurjoPayGateway } from './shurjopay.gateway.js';

type BkashCreds = ShopGatewayCredentials['bkash'];
type SslCreds = ShopGatewayCredentials['sslcommerz'];

/** bKash tokenized checkout for a shop, on the same client as Sellora's own billing. */
class BkashShop implements ShopGatewayAdapter<BkashCreds> {
  readonly descriptor = {
    key: 'bkash' as const,
    name: 'bKash',
    shopperHint: 'Pay with your bKash account',
    fields: [
      { key: 'appKey', label: 'App key', secret: false },
      { key: 'appSecret', label: 'App secret', secret: true },
      { key: 'username', label: 'Username', secret: false },
      { key: 'password', label: 'Password', secret: true },
    ],
    checkable: true,
    help: 'The tokenized checkout keys bKash gave you for your merchant account (app key, app secret, username and password).',
  };
  readonly credentials = shopGatewayCredentials.bkash;

  constructor(private readonly bkash: BkashGateway) {}

  hint(c: BkashCreds): string {
    return `${c.username} · app ${mask(c.appKey)}`;
  }

  async check(c: BkashCreds, sandbox: boolean) {
    await this.bkash.check(c, sandbox);
    return { checked: true, summary: 'bKash accepted the keys.' };
  }

  start(c: BkashCreds, sandbox: boolean, req: ShopStartRequest): Promise<ShopStarted> {
    return this.bkash.createCheckout(c, sandbox, {
      paymentId: req.ref,
      amountMinor: req.amountMinor,
      currency: req.currency,
      description: req.description,
      customer: { name: req.customer.name, phone: req.customer.phone },
      urls: {
        success: req.returnUrl('done'),
        fail: req.returnUrl('done'),
        cancel: req.returnUrl('done'),
        notify: req.notifyUrl,
      },
    });
  }

  private settle(v: Awaited<ReturnType<BkashGateway['query']>>): ShopVerified {
    return {
      status: v.status,
      settled: v.status !== 'pending',
      ...(v.gatewayRef ? { gatewayRef: v.gatewayRef } : {}),
      ...(v.amountMinor !== undefined ? { amountMinor: v.amountMinor } : {}),
      ...(v.currency ? { currency: v.currency } : {}),
      ...(v.invoice ? { ref: v.invoice } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
      raw: v.raw,
    };
  }

  async complete(
    c: BkashCreds,
    sandbox: boolean,
    attempt: ShopAttempt,
    _outcome: string,
    params: Record<string, string>,
  ): Promise<ShopVerified> {
    if (!attempt.sessionId || (params.paymentID && params.paymentID !== attempt.sessionId))
      return { status: 'failed', settled: false, reason: 'bkash_wrong_payment' };
    // bKash says success, failure or cancel; only a success is executed (and then checked).
    if (params.status === 'cancel')
      return { status: 'cancelled', settled: false, reason: 'shopper_cancelled' };
    if (params.status !== 'success')
      return { status: 'failed', settled: false, reason: `bkash_${params.status || 'failure'}` };
    return this.settle(await this.bkash.execute(c, sandbox, attempt.sessionId));
  }

  async lookup(c: BkashCreds, sandbox: boolean, attempt: ShopAttempt): Promise<ShopVerified> {
    if (!attempt.sessionId) return { status: 'pending', settled: false };
    return this.settle(await this.bkash.query(c, sandbox, attempt.sessionId));
  }
}

/** SSLCommerz hosted checkout for a shop, on the same client as Sellora's own billing. */
class SslCommerzShop implements ShopGatewayAdapter<SslCreds> {
  readonly descriptor = {
    key: 'sslcommerz' as const,
    name: 'SSLCommerz',
    shopperHint: 'Card, bKash, Nagad, Rocket and internet banking',
    fields: [
      { key: 'storeId', label: 'Store ID', secret: false },
      { key: 'storePassword', label: 'Store password', secret: true },
    ],
    checkable: true,
    help: 'The store ID and store password (API password) from SSLCommerz, not your panel login.',
  };
  readonly credentials = shopGatewayCredentials.sslcommerz;

  constructor(private readonly ssl: SslCommerzGateway) {}

  hint(c: SslCreds): string {
    return `Store ${c.storeId}`;
  }

  async check(c: SslCreds, sandbox: boolean) {
    const found = await this.ssl.findByTranId(c, sandbox, `CHECK${Date.now()}`);
    if (!found.connected)
      throw new GatewayError('sslcommerz', `SSLCommerz refused the keys (${found.reason})`);
    return { checked: true, summary: 'SSLCommerz accepted the store ID and password.' };
  }

  start(c: SslCreds, sandbox: boolean, req: ShopStartRequest): Promise<ShopStarted> {
    return this.ssl.createCheckout(
      c,
      sandbox,
      {
        paymentId: req.ref,
        amountMinor: req.amountMinor,
        currency: req.currency,
        description: req.description,
        customer: {
          name: req.customer.name,
          email: shopperEmail(req.customer.email, req.customer.phone),
          phone: req.customer.phone,
        },
        urls: {
          success: req.returnUrl('success'),
          fail: req.returnUrl('fail'),
          cancel: req.returnUrl('cancel'),
          notify: req.notifyUrl,
        },
      },
      {
        category: 'General',
        address: req.customer.address,
        ...(req.customer.city ? { city: req.customer.city } : {}),
      },
    );
  }

  private async validate(c: SslCreds, sandbox: boolean, valId: string): Promise<ShopVerified> {
    const v = await this.ssl.validate(c, sandbox, valId);
    return {
      status: v.status === 'succeeded' ? 'succeeded' : 'failed',
      settled: v.status === 'succeeded',
      ...(v.gatewayRef ? { gatewayRef: v.gatewayRef } : {}),
      ...(v.amountMinor !== undefined ? { amountMinor: v.amountMinor } : {}),
      ...(v.currency ? { currency: v.currency } : {}),
      ...(v.tranId ? { ref: v.tranId } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
      raw: v.raw,
    };
  }

  async complete(
    c: SslCreds,
    sandbox: boolean,
    _attempt: ShopAttempt,
    outcome: string,
    params: Record<string, string>,
  ): Promise<ShopVerified> {
    if ((outcome === 'success' || outcome === 'notify') && params.val_id)
      return this.validate(c, sandbox, params.val_id);
    if (outcome === 'cancel')
      return { status: 'cancelled', settled: false, reason: 'shopper_cancelled' };
    return { status: 'failed', settled: false, reason: 'sslcommerz_failed' };
  }

  async lookup(c: SslCreds, sandbox: boolean, attempt: ShopAttempt): Promise<ShopVerified> {
    const found = await this.ssl.findByTranId(c, sandbox, attempt.ref);
    if (found.valId) return this.validate(c, sandbox, found.valId);
    if (found.failed) return { status: 'failed', settled: true, reason: 'sslcommerz_failed' };
    return { status: 'pending', settled: false };
  }
}

/** The five gateways a business can take shoppers' payments with (ADR 0029). */
@Injectable()
export class ShopGateways {
  private readonly byKey: { [K in ShopGatewayKey]: ShopGatewayAdapter<ShopGatewayCredentials[K]> };

  constructor(
    bkash: BkashGateway,
    ssl: SslCommerzGateway,
    nagad: NagadGateway,
    aamarpay: AamarPayGateway,
    shurjopay: ShurjoPayGateway,
  ) {
    this.byKey = {
      bkash: new BkashShop(bkash),
      nagad,
      sslcommerz: new SslCommerzShop(ssl),
      aamarpay,
      shurjopay,
    };
  }

  get(key: ShopGatewayKey): ShopGatewayAdapter<Record<string, string>> {
    // Each adapter's credential schema parses exactly the keys its own methods read.
    return this.byKey[key];
  }

  all(): ShopGatewayAdapter<Record<string, string>>[] {
    return (Object.keys(this.byKey) as ShopGatewayKey[]).map((k) => this.get(k));
  }
}
