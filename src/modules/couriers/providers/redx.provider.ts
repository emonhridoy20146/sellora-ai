import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AppConfig } from '../../../config/app-config.js';
import { REDIS } from '../../../infra/redis/redis.module.js';
import type { ShipmentStatus } from '../../commerce/schemas.js';
import {
  COURIER_FETCH,
  CourierError,
  fillTrackingUrl,
  statusKey,
  type BookingRequest,
  type BookingResult,
  type CourierContext,
  type CourierDescriptor,
  type CourierProvider,
  type LocationOption,
  type LocationQuery,
  type ParcelRef,
  type StatusResult,
  type Translation,
  type WebhookRefs,
} from '../courier.types.js';
import { collectIds, CourierHttp, idString, pick } from './courier-http.js';

const credentials = z.object({ accessToken: z.string().trim().min(16).max(4000) }).strict();
export type RedxCredentials = z.infer<typeof credentials>;

const AREAS_TTL_S = 24 * 3600;

/** RedX parcel statuses (API and webhooks use the same words). */
const STATUSES: Record<string, ShipmentStatus> = {
  pickup_pending: 'booked',
  ready_for_delivery: 'in_transit',
  delivery_in_progress: 'in_transit',
  agent_area_change: 'in_transit',
  agent_hold: 'on_hold',
  agent_returning: 'returning',
  returned: 'returned',
  delivered: 'delivered',
  paid: 'delivered',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

/**
 * RedX open API. A static token in the API-ACCESS-TOKEN header. RedX webhooks are not
 * signed: the secret callback address is the only proof, so their content only ever
 * prompts a status check through the API.
 */
@Injectable()
export class RedxProvider implements CourierProvider<RedxCredentials> {
  readonly descriptor: CourierDescriptor = {
    key: 'redx',
    name: 'RedX',
    credentialFields: [
      {
        key: 'accessToken',
        label: 'API access token',
        secret: true,
        help: 'RedX merchant panel › Developer API',
      },
    ],
    deliveryTypes: [],
    sandbox: true,
    pickupStore: 'optional',
    location: 'area',
    locationRequired: true,
    weightGrams: { min: 1, max: 30_000 },
    webhookAuth: 'url',
    webhookHelp:
      'In the RedX merchant panel, open Developer API › Webhook and paste the callback URL. RedX does not sign webhooks; the address itself is the secret.',
  };
  readonly credentials = credentials;
  private readonly http: CourierHttp;

  constructor(
    private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(COURIER_FETCH) fetchFn: typeof fetch,
  ) {
    this.http = new CourierHttp(fetchFn, 'RedX', config.get('COURIER_HTTP_TIMEOUT_MS'));
  }

  private url(sandbox: boolean, path: string) {
    const base = this.config.get(sandbox ? 'COURIER_REDX_SANDBOX_URL' : 'COURIER_REDX_BASE_URL');
    return `${base.replace(/\/$/, '')}${path}`;
  }

  private headers(c: RedxCredentials) {
    return { 'API-ACCESS-TOKEN': `Bearer ${c.accessToken}` };
  }

  hint(c: RedxCredentials): string {
    return `Token …${c.accessToken.slice(-4)}`;
  }

  async verify(ctx: CourierContext<RedxCredentials>) {
    const { body } = await this.http.send({
      method: 'GET',
      url: this.url(ctx.sandbox, '/pickup/stores'),
      headers: this.headers(ctx.credentials),
    });
    const rows = pick(body, 'pickup_stores');
    const stores = (Array.isArray(rows) ? rows : []).flatMap((s) => {
      const id = idString(pick(s, 'id'));
      const name = idString(pick(s, 'name'));
      if (!id || !name) return [];
      const address = idString(pick(s, 'address'));
      return [{ id, name, ...(address ? { address } : {}) }];
    });
    return {
      summary: `Connected. ${stores.length} RedX pickup store${stores.length === 1 ? '' : 's'}.`,
      stores,
    };
  }

  async book(ctx: CourierContext<RedxCredentials>, req: BookingRequest): Promise<BookingResult> {
    const area = req.location;
    if (!area?.areaId || !area.areaName)
      throw new CourierError('rejected', 'Choose the RedX delivery area for this parcel.');
    const { body } = await this.http.send({
      method: 'POST',
      url: this.url(ctx.sandbox, '/parcel'),
      headers: this.headers(ctx.credentials),
      creates: true,
      body: {
        customer_name: req.recipient.name.slice(0, 100),
        customer_phone: req.recipient.phone,
        delivery_area: area.areaName,
        delivery_area_id: area.areaId,
        customer_address: req.recipient.address.slice(0, 250),
        merchant_invoice_id: req.invoice,
        cash_collection_amount: String(Math.round(req.codMinor / 100)),
        parcel_weight: Math.max(1, Math.round(req.weightGrams)),
        ...(req.note ? { instruction: req.note.slice(0, 250) } : {}),
        value: Math.round(req.valueMinor / 100),
        ...(ctx.settings.storeId ? { pickup_store_id: Number(ctx.settings.storeId) } : {}),
        parcel_details_json: [],
      },
    });
    const trackingId = idString(pick(body, 'tracking_id'));
    if (!trackingId)
      throw new CourierError(
        'uncertain',
        'RedX answered without a tracking id. It may or may not have made the booking.',
      );
    return {
      consignmentId: trackingId,
      trackingCode: trackingId,
      providerStatus: 'pickup-pending',
    };
  }

  async status(ctx: CourierContext<RedxCredentials>, ref: ParcelRef): Promise<StatusResult> {
    const id = ref.trackingCode ?? ref.consignmentId;
    if (!id)
      throw new CourierError('unavailable', 'RedX can only look a parcel up by its tracking id.');
    const { body } = await this.http.send({
      method: 'GET',
      url: this.url(ctx.sandbox, `/parcel/info/${encodeURIComponent(id)}`),
      headers: this.headers(ctx.credentials),
    });
    const status = idString(pick(body, 'parcel', 'status')) ?? idString(pick(body, 'status'));
    if (!status) throw new CourierError('unavailable', 'RedX answered without a parcel status.');
    return { providerStatus: status };
  }

  translate(providerStatus: string): Translation {
    return { status: STATUSES[statusKey(providerStatus)] ?? null };
  }

  /** RedX areas, searched by name or post code. The full list is cached for a day. */
  async locations(
    ctx: CourierContext<RedxCredentials>,
    q: LocationQuery,
  ): Promise<LocationOption[]> {
    if (q.kind !== 'area') return [];
    const cacheKey = `courier:redx:areas:${ctx.sandbox ? 's' : 'p'}`;
    let all: (LocationOption & { postCode?: string })[] | null = null;
    const cached = await this.redis.get(cacheKey);
    if (cached) all = JSON.parse(cached) as (LocationOption & { postCode?: string })[];
    if (!all) {
      const { body } = await this.http.send({
        method: 'GET',
        url: this.url(ctx.sandbox, '/areas'),
        headers: this.headers(ctx.credentials),
      });
      const rows = pick(body, 'areas');
      all = (Array.isArray(rows) ? rows : []).flatMap((r) => {
        const id = Number(pick(r, 'id'));
        const name = idString(pick(r, 'name'));
        if (!Number.isInteger(id) || !name) return [];
        const postCode = idString(pick(r, 'post_code'));
        const division = idString(pick(r, 'division_name'));
        return [
          {
            id,
            name,
            ...(postCode ? { postCode } : {}),
            ...(division || postCode
              ? { hint: [division, postCode].filter(Boolean).join(' · ') }
              : {}),
          },
        ];
      });
      if (all.length) await this.redis.set(cacheKey, JSON.stringify(all), 'EX', AREAS_TTL_S);
    }
    const s = q.search?.trim().toLowerCase();
    const found = s ? all.filter((a) => a.name.toLowerCase().includes(s) || a.postCode === s) : all;
    return found
      .slice(0, 50)
      .map(({ id, name, hint }) => ({ id, name, ...(hint ? { hint } : {}) }));
  }

  trackingUrl(p: { consignmentId?: string; trackingCode?: string; phone: string }) {
    return fillTrackingUrl(this.config.get('COURIER_REDX_TRACKING_URL'), {
      tracking: p.trackingCode ?? p.consignmentId,
      consignment: p.consignmentId,
      phone: p.phone,
    });
  }

  webhookRefs(body: unknown): WebhookRefs {
    const tracking = collectIds(body, ['tracking_number', 'tracking_id']);
    return {
      consignmentIds: tracking,
      trackingCodes: tracking,
      invoices: collectIds(body, ['invoice_number', 'merchant_invoice_id']),
    };
  }

  /** RedX does not sign webhooks: knowing the secret address is the only proof. */
  verifyWebhook(): boolean {
    return true;
  }

  webhookReply() {
    return { status: 200, headers: {} };
  }
}
