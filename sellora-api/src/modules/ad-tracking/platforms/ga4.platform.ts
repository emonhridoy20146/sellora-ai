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
import { e164, gaClientIdFrom, hashed, major, normEmail } from '../hash.js';

const EVENT: Partial<Record<AdEventName, string>> = { Purchase: 'purchase', Refund: 'refund' };

export const GA4_DESCRIPTOR: AdPlatformDescriptor = {
  key: 'ga4',
  name: 'Google Analytics 4',
  publicIdLabel: 'Measurement ID',
  publicIdHint: 'Admin › Data streams › your web stream: the ID that starts with G-.',
  publicIdPattern: /^G-[A-Z0-9]{4,20}$/,
  secretLabel: 'Measurement Protocol API secret',
  secretHint:
    'In the same web stream › Measurement Protocol API secrets › Create. Optional: without it purchases are not sent to Analytics.',
  testCodeLabel: null,
  conversionLabel: false,
  serverEvents: ['Purchase', 'Refund'],
  chatOrders: true,
};

interface ValidationMessage {
  description?: string;
  fieldPath?: string;
}

/**
 * GA4 Measurement Protocol for purchases and refunds; page views, product views, the cart
 * and checkout come from gtag in the browser. Purchases are sent only from the server, so
 * Analytics never sees one twice. GA4 answers 2xx even to a bad request, so a "sent" here
 * only means it was delivered; the test uses the validation endpoint first.
 */
@Injectable()
export class Ga4AdPlatform {
  readonly descriptor = GA4_DESCRIPTOR;

  constructor(
    private readonly config: AppConfig,
    @Inject(AD_FETCH) private readonly http: AdFetch,
  ) {}

  handles(name: AdEventName): boolean {
    return Boolean(EVENT[name]);
  }

  /** The request body. Exposed for tests. */
  payload(e: AdEvent) {
    const u = e.user;
    const email = hashed(normEmail(u.email));
    const phone = hashed(e164(u.phone));
    const consent = e.consent ? 'GRANTED' : 'DENIED';
    return {
      client_id: u.gaClientId ?? gaClientIdFrom(u.externalId ?? e.eventId),
      timestamp_micros: e.time * 1_000_000,
      consent: { ad_user_data: consent, ad_personalization: consent },
      ...(e.consent && (email || phone)
        ? {
            user_data: {
              ...(email ? { sha256_email_address: [email] } : {}),
              ...(phone ? { sha256_phone_number: [phone] } : {}),
            },
          }
        : {}),
      events: [
        {
          name: e.test ? 'sellora_test' : EVENT[e.name]!,
          params: {
            ...(e.orderNumber ? { transaction_id: e.orderNumber } : {}),
            currency: e.currency,
            ...(e.valueMinor !== undefined ? { value: major(e.valueMinor) } : {}),
            items: e.items.map((i) => ({
              item_id: i.id,
              item_name: i.name.slice(0, 100),
              price: major(i.priceMinor),
              quantity: i.quantity,
            })),
            ...(u.gaSessionId ? { session_id: u.gaSessionId } : {}),
            engagement_time_msec: 1,
            ...(e.test ? { debug_mode: true } : {}),
          },
        },
      ],
    };
  }

  private url(path: string, target: AdSendTarget): string {
    const base = this.config.get('TRACKING_GA4_BASE_URL').replace(/\/$/, '');
    return `${base}${path}?measurement_id=${encodeURIComponent(target.publicId)}&api_secret=${encodeURIComponent(target.secret)}`;
  }

  private async post(url: string, body: unknown): Promise<Response> {
    try {
      return await this.http(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AD_TIMEOUT_MS),
      });
    } catch {
      throw new AdPlatformError('Google Analytics could not be reached.', true);
    }
  }

  async send(target: AdSendTarget, e: AdEvent): Promise<string> {
    const body = this.payload(e);
    if (e.test) {
      // The validation server checks the request; it never stores anything.
      const check = await this.post(this.url('/debug/mp/collect', target), body);
      const json = (await check.json().catch(() => ({}))) as {
        validationMessages?: ValidationMessage[];
      };
      const problem = json.validationMessages?.[0];
      if (problem)
        throw new AdPlatformError(
          `Google Analytics found a problem: ${problem.description ?? 'invalid request'}${problem.fieldPath ? ` (${problem.fieldPath})` : ''}.`,
          false,
          check.status,
        );
    }
    const res = await this.post(this.url('/mp/collect', target), body);
    if (!res.ok)
      throw new AdPlatformError(
        `Google Analytics answered ${res.status}.`,
        res.status >= 500,
        res.status,
      );
    return e.test
      ? 'Google Analytics took the test event: see Admin › DebugView. It never checks the API secret, so a wrong one fails silently.'
      : 'Delivered to Google Analytics.';
  }
}
