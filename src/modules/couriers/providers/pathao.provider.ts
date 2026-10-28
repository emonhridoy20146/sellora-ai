import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { EncryptionService } from '../../../common/crypto/encryption.service.js';
import { safeEqual } from '../../../common/crypto/tokens.js';
import { AppConfig } from '../../../config/app-config.js';
import { REDIS } from '../../../infra/redis/redis.module.js';
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
  type LocationOption,
  type LocationQuery,
  type ParcelRef,
  type StatusResult,
  type Translation,
  type WebhookHeaders,
  type WebhookRefs,
} from '../courier.types.js';
import {
  collectIds,
  CourierHttp,
  idString,
  pick,
  takaToMinor,
  type CourierCall,
} from './courier-http.js';

const credentials = z
  .object({
    clientId: z.string().trim().min(4).max(200),
    clientSecret: z.string().trim().min(8).max(300),
    username: z.string().trim().min(3).max(200),
    password: z.string().min(4).max(200),
  })
  .strict();
export type PathaoCredentials = z.infer<typeof credentials>;

const API = '/aladdin/api/v1';
const LOCATION_TTL_S = 24 * 3600;

/**
 * Pathao's order statuses and webhook events, as status keys. Pathao spells them in several
 * ways ("Pickup_Requested", "Pickup Requested", "order.pickup-requested"); statusKey() folds
 * them together. A failed delivery attempt stays in transit (Pathao tries again or returns it).
 */
const STATUSES: Record<string, ShipmentStatus> = {
  pending: 'booked',
  created: 'booked',
  order_created: 'booked',
  updated: 'booked',
  pickup_requested: 'booked',
  assigned_for_pickup: 'booked',
  pickup_failed: 'booked',
  pickup_cancelled: 'cancelled',
  picked: 'picked_up',
  picked_up: 'picked_up',
  at_the_sorting_hub: 'in_transit',
  in_transit: 'in_transit',
  received_at_last_mile_hub: 'in_transit',
  assigned_for_delivery: 'in_transit',
  delivery_failed: 'in_transit',
  on_hold: 'on_hold',
  hold: 'on_hold',
  delivered: 'delivered',
  paid: 'delivered',
  payment_invoice: 'delivered',
  partial_delivery: 'partly_delivered',
  partial_delivered: 'partly_delivered',
  return_id_created: 'returning',
  return_in_transit: 'returning',
  return: 'returned',
  returned: 'returned',
  returned_to_merchant: 'returned',
  paid_return: 'returned',
};

const NOTES: Record<string, string> = {
  pickup_failed: 'Pathao could not pick the parcel up. Check with Pathao when they will try again.',
  delivery_failed: 'Pathao could not deliver on this attempt.',
};

/**
 * Pathao Courier merchant API (aladdin). OAuth password grant per merchant account; the
 * access token is cached in Redis (encrypted) until shortly before it expires. Pathao's
 * webhook sends the merchant's secret in X-PATHAO-Signature and expects it back in
 * X-Pathao-Merchant-Webhook-Integration-Secret.
 */
@Injectable()
export class PathaoProvider implements CourierProvider<PathaoCredentials> {
  readonly descriptor: CourierDescriptor = {
    key: 'pathao',
    name: 'Pathao',
    credentialFields: [
      {
        key: 'clientId',
        label: 'Client ID',
        secret: false,
        help: 'Pathao merchant panel › Developers API',
      },
      { key: 'clientSecret', label: 'Client secret', secret: true },
      { key: 'username', label: 'Merchant login email', secret: false },
      { key: 'password', label: 'Merchant login password', secret: true },
    ],
    deliveryTypes: [
      { value: 'normal', label: 'Normal delivery' },
      { value: 'on_demand', label: 'On-demand delivery' },
    ],
    sandbox: true,
    pickupStore: 'required',
    location: 'city_zone_area',
    locationRequired: false,
    weightGrams: { min: 500, max: 10_000 },
    webhookAuth: 'secret_header',
    webhookHelp:
      'In the Pathao merchant panel, open Developers API › Webhook. Paste the callback URL and the secret, then save; Pathao checks the address at once.',
  };
  readonly credentials = credentials;
  private readonly http: CourierHttp;

  constructor(
    private readonly config: AppConfig,
    private readonly encryption: EncryptionService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(COURIER_FETCH) fetchFn: typeof fetch,
  ) {
    this.http = new CourierHttp(fetchFn, 'Pathao', config.get('COURIER_HTTP_TIMEOUT_MS'));
  }

  private base(sandbox: boolean) {
    return this.config
      .get(sandbox ? 'COURIER_PATHAO_SANDBOX_URL' : 'COURIER_PATHAO_BASE_URL')
      .replace(/\/$/, '');
  }

  /** The cache key changes with the credentials, so new credentials never use an old token. */
  private tokenKey(ctx: CourierContext<PathaoCredentials>) {
    const c = ctx.credentials;
    const fingerprint = createHash('sha256')
      .update([ctx.sandbox, c.clientId, c.clientSecret, c.username, c.password].join('\u0000'))
      .digest('hex')
      .slice(0, 16);
    return `courier:pathao:token:${ctx.accountId}:${fingerprint}`;
  }

  private async token(ctx: CourierContext<PathaoCredentials>, fresh = false): Promise<string> {
    const key = this.tokenKey(ctx);
    const aad = `courier-token:${ctx.accountId}`;
    if (!fresh) {
      const cached = await this.redis.get(key);
      if (cached) {
        try {
          return this.encryption.decrypt(cached, aad);
        } catch {
          // Keys were rotated or the value is damaged: issue a new token.
        }
      }
    }
    const c = ctx.credentials;
    let reply;
    try {
      reply = await this.http.send({
        method: 'POST',
        url: `${this.base(ctx.sandbox)}${API}/issue-token`,
        body: {
          client_id: c.clientId,
          client_secret: c.clientSecret,
          grant_type: 'password',
          username: c.username,
          password: c.password,
        },
      });
    } catch (err) {
      // Pathao answers wrong credentials with 400 or 422 as well as 401.
      if (err instanceof CourierError && err.kind === 'rejected')
        throw new CourierError(
          'auth',
          `Pathao did not accept the API credentials: ${err.message.replace(/^Pathao: /, '')}`,
          err.httpStatus,
        );
      throw err;
    }
    const token = idString(pick(reply.body, 'access_token'));
    if (!token) throw new CourierError('auth', 'Pathao did not issue an access token.');
    const expiresIn = Number(pick(reply.body, 'expires_in'));
    const ttl =
      Number.isFinite(expiresIn) && expiresIn > 600 ? Math.min(expiresIn - 300, 7 * 86_400) : 3_000;
    await this.redis.set(key, this.encryption.encrypt(token, aad), 'EX', ttl);
    return token;
  }

  /** A call with the account's token; a rejected token is renewed once. */
  private async call(ctx: CourierContext<PathaoCredentials>, call: CourierCall) {
    const withToken = async (fresh: boolean) =>
      this.http.send({
        ...call,
        url: `${this.base(ctx.sandbox)}${API}${call.url}`,
        headers: { authorization: `Bearer ${await this.token(ctx, fresh)}` },
      });
    try {
      return await withToken(false);
    } catch (err) {
      if (err instanceof CourierError && err.kind === 'auth') return withToken(true);
      throw err;
    }
  }

  hint(c: PathaoCredentials): string {
    return c.username;
  }

  async verify(ctx: CourierContext<PathaoCredentials>) {
    const { body } = await this.call(ctx, { method: 'GET', url: '/stores' });
    const rows = pick(body, 'data', 'data');
    const stores = (Array.isArray(rows) ? rows : []).flatMap((s) => {
      const id = idString(pick(s, 'store_id'));
      const name = idString(pick(s, 'store_name'));
      if (!id || !name) return [];
      const address = idString(pick(s, 'store_address'));
      return [{ id, name, ...(address ? { address } : {}) }];
    });
    return {
      summary: `Connected. ${stores.length} Pathao pickup store${stores.length === 1 ? '' : 's'}.`,
      stores,
    };
  }

  async book(ctx: CourierContext<PathaoCredentials>, req: BookingRequest): Promise<BookingResult> {
    const storeId = Number(ctx.settings.storeId);
    if (!ctx.settings.storeId || !Number.isInteger(storeId))
      throw new CourierError(
        'rejected',
        'Choose the Pathao pickup store for this account in Settings › Couriers first.',
      );
    const loc = req.location ?? {};
    const { body } = await this.call(ctx, {
      method: 'POST',
      url: '/orders',
      creates: true,
      body: {
        store_id: storeId,
        merchant_order_id: req.invoice,
        recipient_name: req.recipient.name.slice(0, 100),
        recipient_phone: req.recipient.phone,
        ...(req.recipient.altPhone ? { recipient_secondary_phone: req.recipient.altPhone } : {}),
        recipient_address: req.recipient.address.slice(0, 220),
        ...(loc.cityId ? { recipient_city: loc.cityId } : {}),
        ...(loc.zoneId ? { recipient_zone: loc.zoneId } : {}),
        ...(loc.areaId ? { recipient_area: loc.areaId } : {}),
        delivery_type: ctx.settings.deliveryType === 'on_demand' ? 12 : 48,
        item_type: 2,
        ...(req.note ? { special_instruction: req.note.slice(0, 250) } : {}),
        item_quantity: req.quantity,
        item_weight: Math.max(0.5, Math.round(req.weightGrams / 100) / 10),
        item_description: req.description,
        amount_to_collect: Math.round(req.codMinor / 100),
      },
    });
    const consignmentId = idString(pick(body, 'data', 'consignment_id'));
    if (!consignmentId)
      throw new CourierError(
        'uncertain',
        'Pathao answered without a consignment id. It may or may not have made the booking.',
      );
    const fee = takaToMinor(pick(body, 'data', 'delivery_fee'));
    return {
      consignmentId,
      trackingCode: consignmentId,
      providerStatus: idString(pick(body, 'data', 'order_status')) ?? 'Pending',
      ...(fee !== undefined ? { deliveryFeeMinor: fee } : {}),
    };
  }

  async status(ctx: CourierContext<PathaoCredentials>, ref: ParcelRef): Promise<StatusResult> {
    if (!ref.consignmentId)
      throw new CourierError(
        'unavailable',
        'Pathao can only look a parcel up by its consignment id.',
      );
    const { body } = await this.call(ctx, {
      method: 'GET',
      url: `/orders/${encodeURIComponent(ref.consignmentId)}/info`,
    });
    const status =
      idString(pick(body, 'data', 'order_status_slug')) ??
      idString(pick(body, 'data', 'order_status'));
    if (!status) throw new CourierError('unavailable', 'Pathao answered without an order status.');
    return { providerStatus: status };
  }

  translate(providerStatus: string): Translation {
    const key = statusKey(providerStatus);
    return { status: STATUSES[key] ?? null, ...(NOTES[key] ? { attention: NOTES[key] } : {}) };
  }

  async locations(
    ctx: CourierContext<PathaoCredentials>,
    q: LocationQuery,
  ): Promise<LocationOption[]> {
    const path =
      q.kind === 'city'
        ? '/city-list'
        : q.kind === 'zone'
          ? `/cities/${q.parentId}/zone-list`
          : `/zones/${q.parentId}/area-list`;
    if (q.kind !== 'city' && !q.parentId) return [];
    // City, zone and area lists are the same for every merchant, so they are shared.
    const cacheKey = `courier:pathao:loc:${ctx.sandbox ? 's' : 'p'}:${q.kind}:${q.parentId ?? 0}`;
    let all: LocationOption[] | null = null;
    const cached = await this.redis.get(cacheKey);
    if (cached) all = JSON.parse(cached) as LocationOption[];
    if (!all) {
      const { body } = await this.call(ctx, { method: 'GET', url: path });
      const rows = pick(body, 'data', 'data');
      all = (Array.isArray(rows) ? rows : []).flatMap((r): LocationOption[] => {
        const id = Number(pick(r, `${q.kind}_id`));
        const name = idString(pick(r, `${q.kind}_name`));
        if (!Number.isInteger(id) || !name) return [];
        const home = pick(r, 'home_delivery_available');
        return [{ id, name, ...(home === false ? { hint: 'No home delivery' } : {}) }];
      });
      if (all.length) await this.redis.set(cacheKey, JSON.stringify(all), 'EX', LOCATION_TTL_S);
    }
    const s = q.search?.trim().toLowerCase();
    return s ? all.filter((l) => l.name.toLowerCase().includes(s)) : all;
  }

  trackingUrl(p: { consignmentId?: string; trackingCode?: string; phone: string }) {
    return fillTrackingUrl(this.config.get('COURIER_PATHAO_TRACKING_URL'), {
      tracking: p.trackingCode ?? p.consignmentId,
      consignment: p.consignmentId,
      phone: p.phone,
    });
  }

  webhookRefs(body: unknown): WebhookRefs {
    return {
      consignmentIds: collectIds(body, ['consignment_id']),
      trackingCodes: [],
      invoices: collectIds(body, ['merchant_order_id']),
    };
  }

  /** Pathao sends the secret the merchant entered, as it is, in X-PATHAO-Signature. */
  verifyWebhook(headers: WebhookHeaders, secret: string): boolean {
    const sent = header(headers, 'x-pathao-signature');
    return Boolean(sent) && safeEqual(sent!.trim(), secret);
  }

  /** Pathao checks a new webhook address by this header (and a 202) before saving it. */
  webhookReply(secret: string) {
    return {
      status: 202,
      headers: { 'X-Pathao-Merchant-Webhook-Integration-Secret': secret },
    };
  }
}
