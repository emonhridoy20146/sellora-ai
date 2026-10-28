import { Inject, Injectable } from '@nestjs/common';
import { safeEqual } from '../../../common/crypto/tokens.js';
import { z } from 'zod';
import { AppConfig } from '../../../config/app-config.js';
import type { ShipmentStatus } from '../../commerce/schemas.js';
import {
  COURIER_FETCH,
  CourierError,
  fillTrackingUrl,
  header,
  statusKey,
  type BookingRequest,
  type BookingResult,
  type CourierContext,
  type CourierDescriptor,
  type CourierProvider,
  type ParcelRef,
  type StatusResult,
  type Translation,
  type WebhookHeaders,
  type WebhookRefs,
} from '../courier.types.js';
import { collectIds, CourierHttp, idString, pick } from './courier-http.js';

const credentials = z
  .object({
    apiKey: z.string().trim().min(8).max(200),
    secretKey: z.string().trim().min(8).max(200),
  })
  .strict();
export type SteadfastCredentials = z.infer<typeof credentials>;

/**
 * Steadfast's delivery_status words. "pending" means accepted and on its way (Steadfast has
 * no separate pickup status); "*_approval_pending" waits for Steadfast to confirm what the
 * rider reported, so it is not final yet. A "cancelled" parcel after pickup comes back to
 * the business, so it counts as returned.
 */
const STATUSES: Record<string, ShipmentStatus> = {
  in_review: 'booked',
  pending: 'in_transit',
  hold: 'on_hold',
  delivered_approval_pending: 'in_transit',
  partial_delivered_approval_pending: 'in_transit',
  cancelled_approval_pending: 'returning',
  delivered: 'delivered',
  partial_delivered: 'partly_delivered',
};

const BEFORE_PICKUP: readonly ShipmentStatus[] = ['queued', 'sending', 'booked'];

/**
 * Steadfast Courier (steadfast.com.bd). API: Api-Key and Secret-Key headers; create_order,
 * status_by_cid, status_by_invoice, get_balance. Webhooks carry a bearer token the merchant
 * sets in the Steadfast panel.
 */
@Injectable()
export class SteadfastProvider implements CourierProvider<SteadfastCredentials> {
  readonly descriptor: CourierDescriptor = {
    key: 'steadfast',
    name: 'Steadfast',
    credentialFields: [
      { key: 'apiKey', label: 'API key', secret: false, help: 'Steadfast panel › API' },
      { key: 'secretKey', label: 'Secret key', secret: true },
    ],
    deliveryTypes: [
      { value: 'home', label: 'Home delivery' },
      { value: 'point', label: 'Point delivery (customer collects)' },
    ],
    sandbox: false,
    pickupStore: 'none',
    location: 'none',
    locationRequired: false,
    weightGrams: { min: 1, max: 50_000 },
    webhookAuth: 'bearer',
    webhookHelp:
      'In the Steadfast panel, open API › Webhook. Paste the callback URL, and paste the secret as the auth token (Bearer).',
  };
  readonly credentials = credentials;
  private readonly http: CourierHttp;

  constructor(
    private readonly config: AppConfig,
    @Inject(COURIER_FETCH) fetchFn: typeof fetch,
  ) {
    this.http = new CourierHttp(fetchFn, 'Steadfast', config.get('COURIER_HTTP_TIMEOUT_MS'));
  }

  private url(path: string) {
    return `${this.config.get('COURIER_STEADFAST_BASE_URL').replace(/\/$/, '')}${path}`;
  }

  private headers(c: SteadfastCredentials) {
    return { 'Api-Key': c.apiKey, 'Secret-Key': c.secretKey };
  }

  /** Steadfast answers some errors with HTTP 200 and its own status field. */
  private check(body: unknown): void {
    const status = pick(body, 'status');
    if (typeof status === 'number' && status >= 400) {
      const message = pick(body, 'message');
      throw new CourierError(
        status === 401 || status === 403 ? 'auth' : 'rejected',
        `Steadfast: ${typeof message === 'string' ? message : `refused the request (${status})`}`,
        status,
      );
    }
  }

  hint(c: SteadfastCredentials): string {
    return `API key …${c.apiKey.slice(-4)}`;
  }

  async verify(ctx: CourierContext<SteadfastCredentials>) {
    const { body } = await this.http.send({
      method: 'GET',
      url: this.url('/get_balance'),
      headers: this.headers(ctx.credentials),
    });
    this.check(body);
    const balance = pick(body, 'current_balance');
    return {
      summary:
        typeof balance === 'number' || typeof balance === 'string'
          ? `Connected. Steadfast balance: ৳${balance}.`
          : 'Connected.',
      stores: [],
    };
  }

  async book(
    ctx: CourierContext<SteadfastCredentials>,
    req: BookingRequest,
  ): Promise<BookingResult> {
    const { body } = await this.http.send({
      method: 'POST',
      url: this.url('/create_order'),
      headers: this.headers(ctx.credentials),
      creates: true,
      body: {
        invoice: req.invoice,
        recipient_name: req.recipient.name.slice(0, 100),
        recipient_phone: req.recipient.phone,
        ...(req.recipient.altPhone ? { alternative_phone: req.recipient.altPhone } : {}),
        ...(req.recipient.email ? { recipient_email: req.recipient.email } : {}),
        recipient_address: req.recipient.address.slice(0, 250),
        cod_amount: req.codMinor / 100,
        ...(req.note ? { note: req.note } : {}),
        item_description: req.description,
        total_lot: req.quantity,
        delivery_type: ctx.settings.deliveryType === 'point' ? 1 : 0,
      },
    });
    this.check(body);
    const consignmentId = idString(pick(body, 'consignment', 'consignment_id'));
    if (!consignmentId)
      throw new CourierError(
        'uncertain',
        'Steadfast answered without a consignment id. It may or may not have made the booking.',
      );
    return {
      consignmentId,
      trackingCode: idString(pick(body, 'consignment', 'tracking_code')),
      providerStatus: idString(pick(body, 'consignment', 'status')) ?? 'in_review',
    };
  }

  async status(ctx: CourierContext<SteadfastCredentials>, ref: ParcelRef): Promise<StatusResult> {
    const path = ref.consignmentId
      ? `/status_by_cid/${encodeURIComponent(ref.consignmentId)}`
      : `/status_by_invoice/${encodeURIComponent(ref.invoice)}`;
    const { body } = await this.http.send({
      method: 'GET',
      url: this.url(path),
      headers: this.headers(ctx.credentials),
    });
    this.check(body);
    const status = idString(pick(body, 'delivery_status'));
    if (!status)
      throw new CourierError('unavailable', 'Steadfast answered without a delivery status.');
    return { providerStatus: status };
  }

  async statusByInvoice(
    ctx: CourierContext<SteadfastCredentials>,
    invoice: string,
  ): Promise<StatusResult | 'not_found'> {
    try {
      return await this.status(ctx, { invoice });
    } catch (err) {
      if (err instanceof CourierError && err.kind === 'rejected' && err.httpStatus === 404)
        return 'not_found';
      throw err;
    }
  }

  translate(providerStatus: string, previous: ShipmentStatus): Translation {
    const key = statusKey(providerStatus);
    if (key === 'cancelled')
      return BEFORE_PICKUP.includes(previous) ? { status: 'cancelled' } : { status: 'returned' };
    if (key === 'unknown' || key === 'unknown_approval_pending')
      return {
        status: null,
        attention: 'Steadfast does not know where the parcel is. Check with Steadfast.',
      };
    return { status: STATUSES[key] ?? null };
  }

  trackingUrl(p: { consignmentId?: string; trackingCode?: string; phone: string }) {
    return fillTrackingUrl(this.config.get('COURIER_STEADFAST_TRACKING_URL'), {
      tracking: p.trackingCode,
      consignment: p.consignmentId,
      phone: p.phone,
    });
  }

  webhookRefs(body: unknown): WebhookRefs {
    return {
      consignmentIds: collectIds(body, ['consignment_id', 'cid']),
      trackingCodes: collectIds(body, ['tracking_code']),
      invoices: collectIds(body, ['invoice']),
    };
  }

  /** Steadfast sends the token the merchant entered as "Authorization: Bearer <token>". */
  verifyWebhook(headers: WebhookHeaders, secret: string): boolean {
    const auth = header(headers, 'authorization') ?? '';
    return auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), secret);
  }

  webhookReply() {
    return { status: 200, headers: {} };
  }
}
