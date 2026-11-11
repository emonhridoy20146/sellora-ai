import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config.js';
import {
  AD_FETCH,
  AD_TIMEOUT_MS,
  AdPlatformError,
  type AdEvent,
  type AdEventName,
  type AdFetch,
  type AdPlatformDescriptor,
  type AdSendTarget,
} from '../ad-tracking.types.js';
import { hashed, major, metaPhone, normEmail, normWord, sha256Hex, splitName } from '../hash.js';

const EVENT: Partial<Record<AdEventName, string>> = {
  PageView: 'PageView',
  ViewContent: 'ViewContent',
  AddToCart: 'AddToCart',
  InitiateCheckout: 'InitiateCheckout',
  Purchase: 'Purchase',
};

/** Graph error codes that are worth trying again later (rate limits, temporary faults). */
const TEMPORARY = new Set([1, 2, 4, 17, 32, 341, 613]);

export const META_DESCRIPTOR: AdPlatformDescriptor = {
  key: 'meta',
  name: 'Meta Pixel',
  publicIdLabel: 'Pixel (dataset) ID',
  publicIdHint: 'Events Manager › Data sources › your pixel: the number under its name.',
  publicIdPattern: /^\d{10,20}$/,
  secretLabel: 'Conversions API access token',
  secretHint:
    'Events Manager › your pixel › Settings › Conversions API › Generate access token. Optional: without it only the browser pixel runs.',
  testCodeLabel: 'Test event code',
  conversionLabel: false,
  serverEvents: ['ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'],
  chatOrders: true,
};

/**
 * Meta Conversions API: `POST /{version}/{pixel-id}/events` with the access token as a query
 * parameter. Email, phone, names, city, country and external id are hashed; click and
 * browser ids, IP and user agent are not.
 */
@Injectable()
export class MetaAdPlatform {
  readonly descriptor = META_DESCRIPTOR;

  constructor(
    private readonly config: AppConfig,
    @Inject(AD_FETCH) private readonly http: AdFetch,
  ) {}

  private url(path: string, token: string): string {
    const base = this.config.get('TRACKING_META_BASE_URL').replace(/\/$/, '');
    const join = path.includes('?') ? '&' : '?';
    return `${base}/${this.config.get('META_GRAPH_VERSION')}/${path}${join}access_token=${encodeURIComponent(token)}`;
  }

  handles(name: AdEventName): boolean {
    return Boolean(EVENT[name]);
  }

  /** The event as Meta's `data[]` entry. Exposed for tests. */
  payload(e: AdEvent) {
    const u = e.user;
    const name = splitName(u.firstName ? `${u.firstName} ${u.lastName ?? ''}` : undefined);
    const one = (v: string | undefined) => (v ? [v] : undefined);
    const user_data = Object.fromEntries(
      Object.entries({
        em: one(hashed(normEmail(u.email))),
        ph: one(hashed(metaPhone(u.phone))),
        fn: one(hashed(normWord(name.first))),
        ln: one(hashed(normWord(name.last))),
        ct: one(hashed(normWord(u.city))),
        country: one(hashed(normWord(u.country))),
        external_id: one(u.externalId ? sha256Hex(u.externalId) : undefined),
        client_ip_address: u.ip,
        client_user_agent: u.userAgent,
        fbp: u.fbp,
        fbc: u.fbc,
      }).filter(([, v]) => v !== undefined),
    );
    const custom_data =
      e.name === 'PageView'
        ? undefined
        : {
            currency: e.currency,
            ...(e.valueMinor !== undefined ? { value: major(e.valueMinor) } : {}),
            content_type: 'product',
            content_ids: e.items.map((i) => i.id),
            contents: e.items.map((i) => ({
              id: i.id,
              quantity: i.quantity,
              item_price: major(i.priceMinor),
            })),
            num_items: e.items.reduce((n, i) => n + i.quantity, 0),
            ...(e.orderNumber ? { order_id: e.orderNumber } : {}),
          };
    return {
      event_name: EVENT[e.name]!,
      event_time: e.time,
      event_id: e.eventId,
      action_source: e.actionSource,
      ...(e.url && e.actionSource === 'website' ? { event_source_url: e.url } : {}),
      user_data,
      ...(custom_data ? { custom_data } : {}),
    };
  }

  async send(target: AdSendTarget, e: AdEvent): Promise<string> {
    const body = {
      data: [this.payload(e)],
      ...(e.test && target.testCode ? { test_event_code: target.testCode } : {}),
    };
    const json = await this.call(this.url(`${target.publicId}/events`, target.secret), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const received = Number(json.events_received ?? 0);
    if (received < 1) throw new AdPlatformError('Meta did not take the event.', false);
    return e.test ? 'Meta took the test event: see Events Manager › Test events.' : 'Meta took it.';
  }

  /** Reads the pixel's name with the token: proves both belong together. */
  async check(target: Omit<AdSendTarget, 'testCode'>): Promise<{ name: string }> {
    const json = await this.call(this.url(`${target.publicId}?fields=id,name`, target.secret), {
      method: 'GET',
    });
    return { name: typeof json.name === 'string' ? json.name : target.publicId };
  }

  private async call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.http(url, { ...init, signal: AbortSignal.timeout(AD_TIMEOUT_MS) });
    } catch {
      throw new AdPlatformError('Meta could not be reached.', true);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return json;
    const err = (json.error ?? {}) as Record<string, unknown>;
    const code = Number(err.code ?? 0);
    const message =
      code === 190
        ? 'Meta refused the access token (expired or not for this pixel).'
        : typeof err.error_user_msg === 'string' && err.error_user_msg
          ? err.error_user_msg
          : typeof err.message === 'string' && err.message
            ? err.message
            : `Meta answered ${res.status}.`;
    throw new AdPlatformError(message, res.status >= 500 || TEMPORARY.has(code), res.status);
  }
}
