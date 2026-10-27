import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GatewayError } from './gateway.types.js';
import { StripeGateway } from './stripe.gateway.js';

const secret = 'whsec_test_secret';
const gateway = new StripeGateway(() => Promise.reject(new Error('no network in unit tests')));

function sign(body: string, t: number, key = secret) {
  return `t=${t},v1=${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`;
}

const event = JSON.stringify({
  id: 'evt_1',
  type: 'checkout.session.completed',
  data: {
    object: {
      id: 'cs_1',
      client_reference_id: 'p1',
      payment_status: 'paid',
      amount_total: 5000,
      currency: 'usd',
      payment_intent: 'pi_1',
    },
  },
});

describe('Stripe webhook verification', () => {
  const now = 1_800_000_000;

  it('accepts a correctly signed, fresh event', () => {
    const parsed = gateway.verifyWebhook(Buffer.from(event), sign(event, now), secret, now);
    expect(parsed.id).toBe('evt_1');
    expect(gateway.fromCheckoutEvent(parsed)).toEqual({
      paymentId: 'p1',
      result: expect.objectContaining({
        status: 'succeeded',
        amountMinor: 5000,
        currency: 'USD',
        gatewayRef: 'pi_1',
      }) as unknown,
    });
  });

  it('accepts when any of several v1 signatures matches (secret rotation)', () => {
    const header = `t=${now},v1=deadbeef,${sign(event, now).split(',')[1]}`;
    expect(gateway.verifyWebhook(Buffer.from(event), header, secret, now).id).toBe('evt_1');
  });

  it('rejects a wrong secret, a tampered body, a stale timestamp and a missing header', () => {
    expect(() =>
      gateway.verifyWebhook(Buffer.from(event), sign(event, now, 'whsec_other'), secret, now),
    ).toThrow(GatewayError);
    expect(() =>
      gateway.verifyWebhook(
        Buffer.from(event.replace('5000', '500000')),
        sign(event, now),
        secret,
        now,
      ),
    ).toThrow(/signature mismatch/);
    expect(() =>
      gateway.verifyWebhook(Buffer.from(event), sign(event, now - 301), secret, now),
    ).toThrow(/tolerance/);
    expect(() => gateway.verifyWebhook(Buffer.from(event), undefined, secret, now)).toThrow(
      /Missing/,
    );
  });

  it('treats unpaid completions as pending and expiries as failures', () => {
    const unpaid = {
      id: 'e',
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'p', payment_status: 'unpaid' } },
    };
    expect(gateway.fromCheckoutEvent(unpaid)?.result.status).toBe('pending');
    const expired = {
      id: 'e',
      type: 'checkout.session.expired',
      data: { object: { client_reference_id: 'p' } },
    };
    expect(gateway.fromCheckoutEvent(expired)?.result.status).toBe('failed');
    expect(
      gateway.fromCheckoutEvent({ id: 'e', type: 'invoice.paid', data: { object: {} } }),
    ).toBeNull();
  });
});
