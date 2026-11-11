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
import { e164, hashed, major, normEmail, sha256Hex } from '../hash.js';

const EVENT: Partial<Record<AdEventName, string>> = {
  ViewContent: 'ViewContent',
  AddToCart: 'AddToCart',
  InitiateCheckout: 'InitiateCheckout',
  Purchase: 'Purchase',
};

export const TIKTOK_DESCRIPTOR: AdPlatformDescriptor = {
  key: 'tiktok',
  name: 'TikTok Pixel',
  publicIdLabel: 'Pixel ID',
  publicIdHint: 'TikTok Ads Manager › Tools › Events › Web events: the ID under the pixel name.',
  publicIdPattern: /^[A-Z0-9]{15,30}$/,
  secretLabel: 'Events API access token',
  secretHint:
    'In the pixel’s Settings › Events API › Generate access token. Optional: without it only the browser pixel runs.',
  testCodeLabel: 'Test event code',
  conversionLabel: false,
  serverEvents: ['ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'],
  chatOrders: false,
};

/**
 * TikTok Events API 2.0: `POST /open_api/v1.3/event/track/` with the `Access-Token` header.
 * TikTok answers HTTP 200 with `code: 0` when it took the events; any other code is a refusal.
 * Email and phone (E.164) are hashed; ttclid, ttp, IP and user agent are not.
 */
@Injectable()
export class TikTokAdPlatform {
  readonly descriptor = TIKTOK_DESCRIPTOR;

  constructor(
    private readonly config: AppConfig,
    @Inject(AD_FETCH) private readonly http: AdFetch,
  ) {}

  handles(name: AdEventName): boolean {
    return Boolean(EVENT[name]);
  }

  /** The event as TikTok's `data[]` entry. Exposed for tests. */
  payload(e: AdEvent) {
    const u = e.user;
    const user = Object.fromEntries(
      Object.entries({
        email: hashed(normEmail(u.email)),
        phone: hashed(e164(u.phone)),
        external_id: u.externalId ? sha256Hex(u.externalId) : undefined,
        ttclid: u.ttclid,
        ttp: u.ttp,
        ip: u.ip,
        user_agent: u.userAgent,
      }).filter(([, v]) => v !== undefined),
    );
    return {
      event: EVENT[e.name]!,
      event_time: e.time,
      event_id: e.eventId,
      user,
      ...(e.url ? { page: { url: e.url, ...(e.referrer ? { referrer: e.referrer } : {}) } } : {}),
      properties: {
        currency: e.currency,
        ...(e.valueMinor !== undefined ? { value: major(e.valueMinor) } : {}),
        content_type: 'product',
        contents: e.items.map((i) => ({
          content_id: i.id,
          content_name: i.name,
          content_type: 'product',
          quantity: i.quantity,
          price: major(i.priceMinor),
        })),
        ...(e.orderNumber ? { order_id: e.orderNumber } : {}),
      },
    };
  }

  async send(target: AdSendTarget, e: AdEvent): Promise<string> {
    const base = this.config.get('TRACKING_TIKTOK_BASE_URL').replace(/\/$/, '');
    let res: Response;
    try {
      res = await this.http(`${base}/open_api/v1.3/event/track/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Access-Token': target.secret },
        body: JSON.stringify({
          event_source: 'web',
          event_source_id: target.publicId,
          ...(e.test && target.testCode ? { test_event_code: target.testCode } : {}),
          data: [this.payload(e)],
        }),
        signal: AbortSignal.timeout(AD_TIMEOUT_MS),
      });
    } catch {
      throw new AdPlatformError('TikTok could not be reached.', true);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const code = Number(json.code ?? (res.ok ? 0 : -1));
    if (res.ok && code === 0)
      return e.test
        ? 'TikTok took the test event: see Events Manager › Test events.'
        : 'TikTok took it.';
    const message =
      typeof json.message === 'string' && json.message && json.message !== 'OK'
        ? `TikTok: ${json.message}`
        : `TikTok answered ${res.status}${code ? ` (code ${code})` : ''}.`;
    // 5xx and TikTok's 5xxxx codes are its own faults; 4xxxx are about the request or token.
    throw new AdPlatformError(message, res.status >= 500 || code >= 50000, res.status);
  }
}
