import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { safeEqual } from '../../../common/crypto/tokens.js';
import {
  GATEWAY_FETCH,
  GATEWAY_TIMEOUT_MS,
  GatewayError,
  type CheckoutRequest,
  type CheckoutSession,
  type GatewayCredentials,
  type GatewayFetch,
  type VerifiedPayment,
  str,
} from './gateway.types.js';

const API = 'https://api.stripe.com/v1';
const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Stripe Checkout for international cards. Uses the REST API directly (form-encoded), and
 * trusts payments only through signed webhooks (`Stripe-Signature`, HMAC-SHA256 over
 * "timestamp.body" with the endpoint's signing secret, 5 minute tolerance).
 */
@Injectable()
export class StripeGateway {
  constructor(@Inject(GATEWAY_FETCH) private readonly http: GatewayFetch) {}

  async createCheckout(
    creds: GatewayCredentials['stripe'],
    req: CheckoutRequest,
  ): Promise<CheckoutSession> {
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: req.urls.success,
      cancel_url: req.urls.cancel,
      client_reference_id: req.paymentId,
      'metadata[paymentId]': req.paymentId,
      'payment_intent_data[metadata][paymentId]': req.paymentId,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': req.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(req.amountMinor),
      'line_items[0][price_data][product_data][name]': req.description.slice(0, 250),
    });
    if (req.customer.email) form.set('customer_email', req.customer.email);
    const res = await this.http(`${API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': `checkout-${req.paymentId}`,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.id !== 'string' || typeof body.url !== 'string') {
      const error = (body.error ?? {}) as Record<string, unknown>;
      throw new GatewayError('stripe', 'Stripe did not create a checkout session', {
        httpStatus: res.status,
        code: error.code ?? null,
        message: error.message ?? null,
      });
    }
    return { sessionId: body.id, redirectUrl: body.url, raw: { id: body.id } };
  }

  /** Verifies the signature and parses the event. Throws GatewayError when invalid. */
  verifyWebhook(
    rawBody: Buffer,
    header: string | undefined,
    secret: string,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): StripeEvent {
    if (!header) throw new GatewayError('stripe', 'Missing Stripe-Signature header');
    const parts = header.split(',').map((p) => p.split('=') as [string, string]);
    const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
    const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
    if (!Number.isFinite(timestamp) || signatures.length === 0)
      throw new GatewayError('stripe', 'Malformed Stripe-Signature header');
    if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS)
      throw new GatewayError('stripe', 'Stripe webhook timestamp outside tolerance');
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    if (!signatures.some((sig) => safeEqual(sig, expected)))
      throw new GatewayError('stripe', 'Stripe webhook signature mismatch');
    const event = JSON.parse(rawBody.toString('utf8')) as StripeEvent;
    if (typeof event.id !== 'string' || typeof event.type !== 'string' || !event.data?.object)
      throw new GatewayError('stripe', 'Malformed Stripe event');
    return event;
  }

  /** Reads a checkout.session.* event into our payment id and verified result. */
  fromCheckoutEvent(
    event: StripeEvent,
  ): { paymentId: string | null; result: VerifiedPayment } | null {
    if (!event.type.startsWith('checkout.session.')) return null;
    const s = event.data.object;
    const metadata = (s.metadata ?? {}) as Record<string, unknown>;
    const paymentId =
      typeof s.client_reference_id === 'string'
        ? s.client_reference_id
        : typeof metadata.paymentId === 'string'
          ? metadata.paymentId
          : null;
    const raw = {
      event: event.id,
      type: event.type,
      session: s.id,
      payment_status: s.payment_status,
      amount_total: s.amount_total,
      currency: s.currency,
      payment_intent: s.payment_intent,
    };
    const paid =
      (event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded') &&
      s.payment_status === 'paid';
    if (paid) {
      return {
        paymentId,
        result: {
          status: 'succeeded',
          gatewayRef: typeof s.payment_intent === 'string' ? s.payment_intent : str(s.id),
          amountMinor: Number(s.amount_total),
          currency: str(s.currency).toUpperCase(),
          raw,
        },
      };
    }
    if (
      event.type === 'checkout.session.async_payment_failed' ||
      event.type === 'checkout.session.expired'
    ) {
      return {
        paymentId,
        result: {
          status: 'failed',
          reason:
            event.type === 'checkout.session.expired'
              ? 'stripe_session_expired'
              : 'stripe_payment_failed',
          raw,
        },
      };
    }
    return { paymentId, result: { status: 'pending', raw } };
  }
}
