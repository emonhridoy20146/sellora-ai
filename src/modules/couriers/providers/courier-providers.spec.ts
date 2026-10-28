import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../config/app-config.js';
import { CourierError, fillTrackingUrl, statusKey } from '../courier.types.js';
import { collectIds, courierMessage, CourierHttp } from './courier-http.js';
import { PathaoProvider } from './pathao.provider.js';
import { RedxProvider } from './redx.provider.js';
import { SteadfastProvider } from './steadfast.provider.js';

const config = { get: () => '' } as unknown as AppConfig;
const noFetch = (() =>
  Promise.reject(new Error('no network in unit tests'))) as unknown as typeof fetch;
const steadfast = new SteadfastProvider(config, noFetch);
const pathao = new PathaoProvider(config, null as never, null as never, noFetch);
const redx = new RedxProvider(config, null as never, noFetch);

const answer = (status: number, body: unknown) =>
  (() =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

describe('statusKey', () => {
  it('folds the ways couriers spell the same status', () => {
    expect(statusKey('Pickup_Requested')).toBe('pickup_requested');
    expect(statusKey('Pickup Requested')).toBe('pickup_requested');
    expect(statusKey('order.pickup-requested')).toBe('pickup_requested');
    expect(statusKey('At the Sorting HUB')).toBe('at_the_sorting_hub');
    expect(statusKey(' delivery-in-progress ')).toBe('delivery_in_progress');
  });
});

describe('status translation', () => {
  it('Steadfast: accepted means on its way; approvals are not final', () => {
    expect(steadfast.translate('in_review', 'booked').status).toBe('booked');
    expect(steadfast.translate('pending', 'booked').status).toBe('in_transit');
    expect(steadfast.translate('delivered_approval_pending', 'in_transit').status).toBe(
      'in_transit',
    );
    expect(steadfast.translate('delivered', 'in_transit').status).toBe('delivered');
    expect(steadfast.translate('partial_delivered', 'in_transit').status).toBe('partly_delivered');
    expect(steadfast.translate('hold', 'in_transit').status).toBe('on_hold');
  });

  it('Steadfast: a cancellation before pickup is a cancellation, after it a return', () => {
    expect(steadfast.translate('cancelled', 'booked').status).toBe('cancelled');
    expect(steadfast.translate('cancelled', 'in_transit').status).toBe('returned');
    expect(steadfast.translate('unknown', 'in_transit')).toMatchObject({ status: null });
  });

  it('Pathao: statuses and webhook events map the same way', () => {
    for (const [raw, status] of [
      ['Pending', 'booked'],
      ['order.assigned-for-pickup', 'booked'],
      ['Picked', 'picked_up'],
      ['order.at-the-sorting-hub', 'in_transit'],
      ['Received_at_Last_Mile_HUB', 'in_transit'],
      ['Delivered', 'delivered'],
      ['order.partial-delivery', 'partly_delivered'],
      ['order.return-id-created', 'returning'],
      ['order.returned-to-merchant', 'returned'],
      ['Pickup_Cancelled', 'cancelled'],
      ['On_Hold', 'on_hold'],
    ] as const)
      expect([raw, pathao.translate(raw).status]).toEqual([raw, status]);
    expect(pathao.translate('order.pickup-failed').attention).toContain('could not pick');
    expect(pathao.translate('order.exchanged').status).toBeNull();
  });

  it('RedX', () => {
    expect(redx.translate('pickup-pending').status).toBe('booked');
    expect(redx.translate('ready-for-delivery').status).toBe('in_transit');
    expect(redx.translate('agent-hold').status).toBe('on_hold');
    expect(redx.translate('agent-returning').status).toBe('returning');
    expect(redx.translate('returned').status).toBe('returned');
    expect(redx.translate('delivered').status).toBe('delivered');
    expect(redx.translate('something-new').status).toBeNull();
  });
});

describe('webhooks', () => {
  it('finds parcel references anywhere in the body', () => {
    expect(
      steadfast.webhookRefs({ consignment_id: 1424107, invoice: 'SO-1001', status: 'delivered' }),
    ).toEqual({
      consignmentIds: ['1424107'],
      trackingCodes: [],
      invoices: ['SO-1001'],
    });
    expect(
      redx.webhookRefs({
        tracking_number: '21A427TU4BN3R',
        invoice_number: 'SO-1',
        status: 'delivered',
      }),
    ).toEqual({
      consignmentIds: ['21A427TU4BN3R'],
      trackingCodes: ['21A427TU4BN3R'],
      invoices: ['SO-1'],
    });
    expect(
      collectIds({ data: [{ consignment_id: 'A' }, { consignment_id: 'A' }] }, ['consignment_id']),
    ).toEqual(['A']);
  });

  it('checks the courier’s proof', () => {
    expect(steadfast.verifyWebhook({ authorization: 'Bearer s3cret' }, 's3cret')).toBe(true);
    expect(steadfast.verifyWebhook({ authorization: 'Bearer nope' }, 's3cret')).toBe(false);
    expect(steadfast.verifyWebhook({}, 's3cret')).toBe(false);
    expect(pathao.verifyWebhook({ 'x-pathao-signature': 's3cret' }, 's3cret')).toBe(true);
    expect(pathao.verifyWebhook({ 'x-pathao-signature': 'other' }, 's3cret')).toBe(false);
    expect(pathao.webhookReply('s3cret')).toEqual({
      status: 202,
      headers: { 'X-Pathao-Merchant-Webhook-Integration-Secret': 's3cret' },
    });
  });
});

describe('courier HTTP', () => {
  it('reads couriers’ error bodies', () => {
    expect(
      courierMessage({
        message: 'x',
        errors: { recipient_phone: ['The recipient phone must be 11 digits.'] },
      }),
    ).toBe('The recipient phone must be 11 digits.');
    expect(courierMessage({ errors: { phone: ['invalid'] } })).toBe('phone: invalid');
    expect(courierMessage({ error: { message: 'Bad token' } })).toBe('Bad token');
    expect(courierMessage('nope')).toBeNull();
    expect(courierMessage({ message: 'a'.repeat(400) })).toHaveLength(300);
  });

  it('sorts failures: a lost booking reply is uncertain, a lost read is not', async () => {
    const kind = async (fetchFn: typeof fetch, creates: boolean) => {
      try {
        await new CourierHttp(fetchFn, 'Test', 1000).send({
          method: 'POST',
          url: 'https://x.test',
          creates,
        });
        return 'ok';
      } catch (err) {
        return (err as CourierError).kind;
      }
    };
    expect(await kind(noFetch, true)).toBe('uncertain');
    expect(await kind(noFetch, false)).toBe('unavailable');
    expect(await kind(answer(502, {}), true)).toBe('uncertain');
    expect(await kind(answer(401, {}), true)).toBe('auth');
    expect(await kind(answer(429, {}), true)).toBe('busy');
    expect(await kind(answer(422, { message: 'Bad address' }), true)).toBe('rejected');
    expect(await kind(answer(200, { ok: 1 }), true)).toBe('ok');
  });
});

describe('fillTrackingUrl', () => {
  it('fills the template, or gives no link when a value is missing', () => {
    expect(fillTrackingUrl('https://t.test/{tracking}', { tracking: 'AB 1', phone: '017' })).toBe(
      'https://t.test/AB%201',
    );
    expect(
      fillTrackingUrl('https://t.test/{consignment}?p={phone}', {
        consignment: 'C1',
        phone: '01712345678',
      }),
    ).toBe('https://t.test/C1?p=01712345678');
    expect(fillTrackingUrl('https://t.test/{tracking}', { phone: '017' })).toBeNull();
    expect(fillTrackingUrl('', { tracking: 'X', phone: '017' })).toBeNull();
  });
});
