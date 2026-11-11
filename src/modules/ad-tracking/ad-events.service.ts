import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Types, type Connection } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { OrdersService, type OrderDoc } from '../commerce/orders.service.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { ProductRepository } from '../commerce/repositories.js';
import type { OrderSource } from '../commerce/schemas.js';
import {
  AdPlatformError,
  type AdActionSource,
  type AdEvent,
  type AdEventItem,
  type AdEventName,
  type BrowserCopyEvent,
} from './ad-tracking.types.js';
import {
  AdDestinationsService,
  type AdDestinationDoc,
  type AdSite,
} from './ad-destinations.service.js';
import {
  e164,
  fbcFromClickId,
  hashed,
  normEmail,
  gaClientId,
  gaSessionId,
  splitName,
  validFbId,
  validTtp,
} from './hash.js';
import { AdPlatforms } from './platforms/ad-platforms.js';
import {
  AdDestinationRepository,
  AdEventLogRepository,
  AdOrderContextRepository,
} from './repositories.js';
import type { AdEventSource, AdOrderContext } from './schemas.js';

export const AD_SEND_JOB = 'send';

/** An order's purchase or refund, rebuilt from the order when the job runs (no personal data in Redis). */
export interface AdOrderJob {
  orderId: string;
  name: 'Purchase' | 'Refund';
  /** Unix seconds: when it was placed, delivered or cancelled. */
  time: number;
}

export interface AdJob {
  orgId: string;
  destinationId: string;
  /** A browser event's server copy (no personal details beyond the browser's own ids). */
  event?: AdEvent;
  order?: AdOrderJob;
}

/** The ids and page the shopper's browser sends with an event or an order. */
export interface BrowserIds {
  consent?: boolean | undefined;
  url?: string | undefined;
  referrer?: string | undefined;
  fbp?: string | undefined;
  fbc?: string | undefined;
  ttp?: string | undefined;
  ttclid?: string | undefined;
  fbclid?: string | undefined;
  /** The raw `_ga` cookie. */
  ga?: string | undefined;
  /** The raw `_ga_<stream>` cookie. */
  gaSession?: string | undefined;
  visitorId?: string | undefined;
}

export interface BrowserEventInput extends BrowserIds {
  event: BrowserCopyEvent;
  eventId: string;
  items: { productId: string; variantId?: string | undefined; quantity: number }[];
}

const WEB_SOURCES: readonly OrderSource[] = ['store', 'landing_page'];
const ACTION_SOURCE: Record<OrderSource, AdActionSource> = {
  store: 'website',
  landing_page: 'website',
  inbox: 'chat',
  manual: 'other',
  api: 'other',
};

const nowSec = () => Math.floor(Date.now() / 1000);
const short = (v: string | undefined, max: number) =>
  v === undefined ? undefined : v.slice(0, max) || undefined;

/**
 * Server copies of shopper events and order purchases for the business's ad platforms
 * (ADR 0030). Browser events are copied only to platforms with a server key; purchases come
 * from the order itself (once per order and tracking id), when it is placed or when it is
 * delivered, as each tracking id says. Nothing is sent without the shopper's agreement when
 * the business asks for it.
 */
@Injectable()
export class AdEventsService {
  private readonly logger = new Logger(AdEventsService.name);

  constructor(
    private readonly destinations: AdDestinationsService,
    private readonly destinationRepo: AdDestinationRepository,
    private readonly contexts: AdOrderContextRepository,
    private readonly logs: AdEventLogRepository,
    private readonly platforms: AdPlatforms,
    private readonly orders: OrdersService,
    private readonly products: ProductRepository,
    private readonly limits: RateLimitService,
    private readonly orgs: OrgsService,
    @InjectQueue(QUEUES.adEvents) private readonly queue: Queue<AdJob>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  /** The browser's ids as the platforms take them; anything malformed is dropped. */
  private ids(b: BrowserIds | undefined, at: number) {
    const ctx = RequestContext.current();
    return {
      ip: ctx?.ip,
      userAgent: ctx?.userAgent,
      fbp: validFbId(b?.fbp),
      fbc: validFbId(b?.fbc) ?? fbcFromClickId(b?.fbclid, at),
      ttp: validTtp(b?.ttp),
      ttclid: short(b?.ttclid, 500),
      gaClientId: gaClientId(b?.ga),
      gaSessionId: gaSessionId(b?.gaSession),
    };
  }

  private async consented(b: BrowserIds | undefined): Promise<boolean> {
    const s = await this.destinations.settings();
    return s.consent === 'off' || b?.consent === true;
  }

  private canSend(d: AdDestinationDoc, name: AdEventName): boolean {
    return Boolean(d.secretEnc) && Boolean(this.platforms.server(d.platform)?.handles(name));
  }

  /** Items priced from the catalog, never from what the browser says. */
  private async items(lines: BrowserEventInput['items']): Promise<AdEventItem[]> {
    const ids = lines.map((l) => l.productId).filter((id) => Types.ObjectId.isValid(id));
    if (!ids.length) return [];
    const found = await this.products.find({
      _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
      status: 'active',
    });
    return lines.flatMap((l) => {
      const p = found.find((x) => x._id.toHexString() === l.productId);
      if (!p) return [];
      const v = p.variants.find((x) => x._id.toHexString() === l.variantId) ?? p.variants[0];
      if (!v) return [];
      return [{ id: l.productId, name: p.name, quantity: l.quantity, priceMinor: v.priceMinor }];
    });
  }

  /** A product view, add to cart or checkout start from a store or landing page. */
  async browserEvent(
    site: AdSite,
    input: BrowserEventInput,
    currency: string,
  ): Promise<{ queued: number }> {
    const ip = RequestContext.current()?.ip;
    if (ip) await this.limits.consume('ad-event:ip', ip);
    if (!(await this.consented(input))) return { queued: 0 };
    const targets = (await this.destinations.forSite(site)).filter((d) =>
      this.canSend(d, input.event),
    );
    if (!targets.length) return { queued: 0 };
    const items = await this.items(input.items);
    if (!items.length) return { queued: 0 };
    const time = nowSec();
    const event: AdEvent = {
      name: input.event,
      eventId: input.eventId,
      time,
      actionSource: 'website',
      ...(input.url ? { url: input.url } : {}),
      ...(input.referrer ? { referrer: input.referrer } : {}),
      currency,
      valueMinor: items.reduce((n, i) => n + i.priceMinor * i.quantity, 0),
      items,
      user: {
        ...this.ids(input, time * 1000),
        ...(input.visitorId ? { externalId: `visitor:${input.visitorId}` } : {}),
      },
      consent: true,
    };
    const orgId = this.orgId();
    await Promise.all(
      targets.map((d) =>
        this.queue.add(
          AD_SEND_JOB,
          { orgId, destinationId: d._id.toHexString(), event },
          {
            jobId: `ad-${d._id.toHexString()}-${input.eventId}`,
            attempts: 3,
            removeOnComplete: true,
            removeOnFail: { age: 24 * 3600 },
          },
        ),
      ),
    );
    return { queued: targets.length };
  }

  /**
   * After a store or landing page order is placed: keeps what the browser knew (for a
   * purchase counted on delivery too) and queues the purchase for tracking ids that count
   * it now. Best effort: the order never waits for or fails on ad tracking.
   */
  async orderPlaced(order: OrderDoc, site: AdSite, browser: BrowserIds | undefined) {
    try {
      const consent = await this.consented(browser);
      const at = order.placedAt.getTime();
      const ids = this.ids(browser, at);
      const context: Omit<AdOrderContext, 'orgId'> = {
        orderId: order._id,
        consent,
        ...Object.fromEntries(
          Object.entries({
            url: short(browser?.url, 1000),
            referrer: short(browser?.referrer, 1000),
            ip: ids.ip,
            userAgent: ids.userAgent,
            fbp: ids.fbp,
            fbc: ids.fbc,
            ttp: ids.ttp,
            gaClientId: ids.gaClientId,
            gaSessionId: ids.gaSessionId,
            visitorId: short(browser?.visitorId, 64),
          }).filter(([, v]) => v !== undefined),
        ),
      };
      try {
        await this.contexts.create(context);
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
      if (!consent) return;
      const targets = (await this.destinations.forSite(site)).filter(
        (d) => d.purchaseWhen === 'placed' && this.canSend(d, 'Purchase'),
      );
      await this.queueOrder(targets, order, 'Purchase', Math.floor(at / 1000));
    } catch (err) {
      this.logger.error({ err, orderId: order._id.toHexString() }, 'Could not queue ad events');
    }
  }

  private async queueOrder(
    targets: AdDestinationDoc[],
    order: OrderDoc,
    name: 'Purchase' | 'Refund',
    time: number,
  ) {
    const orgId = this.orgId();
    const orderId = order._id.toHexString();
    await Promise.all(
      targets.map((d) =>
        this.queue.add(
          AD_SEND_JOB,
          { orgId, destinationId: d._id.toHexString(), order: { orderId, name, time } },
          // One job per order, event and tracking id; delivery also checks the log.
          {
            jobId: `ad-${d._id.toHexString()}-${orderId}-${name.toLowerCase()}`,
            attempts: 6,
            backoff: { type: 'exponential', delay: 10_000 },
          },
        ),
      ),
    );
  }

  /** Destinations an order's events go to, by where the order came from. */
  private async targetsFor(order: OrderDoc): Promise<AdDestinationDoc[]> {
    if (WEB_SOURCES.includes(order.source)) {
      const site: AdSite | null = order.landingPage
        ? { type: 'landing', id: order.landingPage.id.toHexString() }
        : order.storeId
          ? { type: 'store', id: order.storeId.toHexString() }
          : null;
      return site ? this.destinations.forSite(site) : [];
    }
    const all = await this.destinationRepo.find({ enabled: true, chatOrders: true });
    return all.filter((d) => this.platforms.descriptor(d.platform).chatOrders);
  }

  /** Whether the shopper agreed (web orders while the business asks first). */
  private async orderConsent(order: OrderDoc): Promise<boolean> {
    if (!WEB_SOURCES.includes(order.source)) return true;
    const ctx = await this.contexts.findOne({ orderId: order._id });
    if (ctx) return ctx.consent;
    return (await this.destinations.settings()).consent === 'off';
  }

  /** Orders from the inbox, added by hand or through the API, for tracking ids that take them. */
  async orderCreated(orderId: string): Promise<void> {
    const order = await this.orders.get(orderId);
    if (WEB_SOURCES.includes(order.source)) return;
    const targets = (await this.targetsFor(order)).filter(
      (d) => d.purchaseWhen === 'placed' && this.canSend(d, 'Purchase'),
    );
    await this.queueOrder(targets, order, 'Purchase', Math.floor(order.placedAt.getTime() / 1000));
  }

  /** Delivered: the purchase for ids that count on delivery. Cancelled or returned: refunds. */
  async orderStatusChanged(orderId: string, to: string): Promise<void> {
    if (to !== 'delivered' && to !== 'cancelled' && to !== 'returned') return;
    const order = await this.orders.get(orderId);
    if (!(await this.orderConsent(order))) return;
    const targets = await this.targetsFor(order);
    if (to === 'delivered') {
      await this.queueOrder(
        targets.filter((d) => d.purchaseWhen === 'delivered' && this.canSend(d, 'Purchase')),
        order,
        'Purchase',
        nowSec(),
      );
      return;
    }
    // Only where a purchase actually went out; GA4 takes refunds, Meta and TikTok do not.
    const refundable = targets.filter((d) => this.canSend(d, 'Refund'));
    const sent = await Promise.all(
      refundable.map((d) =>
        this.logs.exists({
          orderId: order._id,
          destinationId: d._id,
          event: 'Purchase',
          status: 'sent',
        }),
      ),
    );
    await this.queueOrder(
      refundable.filter((_, i) => sent[i]),
      order,
      'Refund',
      nowSec(),
    );
  }

  /** The order's event as the platforms take it, from the order and the browser's details. */
  private async orderEvent(job: AdOrderJob): Promise<AdEvent | null> {
    const order = await this.orders.get(job.orderId).catch(() => null);
    if (!order) return null;
    const ctx = WEB_SOURCES.includes(order.source)
      ? await this.contexts.findOne({ orderId: order._id })
      : null;
    const phone = order.customer.phone ?? order.shippingAddress.phone;
    const name = splitName(order.customer.name);
    const fbc = ctx?.fbc ?? fbcFromClickId(order.attribution?.fbclid, order.placedAt.getTime());
    const web = WEB_SOURCES.includes(order.source);
    return {
      name: job.name,
      eventId: `${job.name.toLowerCase()}.${order._id.toHexString()}`,
      time: job.time,
      // Without the browser's user agent Meta does not take a website event.
      actionSource: web
        ? ctx?.userAgent
          ? 'website'
          : 'system_generated'
        : ACTION_SOURCE[order.source],
      ...(ctx?.url ? { url: ctx.url } : {}),
      ...(ctx?.referrer ? { referrer: ctx.referrer } : {}),
      currency: order.currency,
      valueMinor: order.totalMinor,
      items: order.items.map((i) => ({
        id: i.productId.toHexString(),
        name:
          i.variantTitle && i.variantTitle !== 'Default' ? `${i.name} (${i.variantTitle})` : i.name,
        quantity: i.quantity,
        priceMinor: i.unitPriceMinor,
      })),
      orderId: order._id.toHexString(),
      orderNumber: order.number,
      user: Object.fromEntries(
        Object.entries({
          email: order.customer.email,
          phone,
          firstName: name.first,
          lastName: name.last,
          city: order.shippingAddress.city ?? order.shippingAddress.district,
          // Only what the phone number shows; no country is assumed.
          country: e164(phone)?.startsWith('+880') ? 'bd' : undefined,
          externalId: `customer:${order.customerId.toHexString()}`,
          ip: ctx?.ip,
          userAgent: ctx?.userAgent,
          fbp: ctx?.fbp,
          fbc,
          ttp: ctx?.ttp,
          ttclid: order.attribution?.ttclid,
          gaClientId: ctx?.gaClientId,
          gaSessionId: ctx?.gaSessionId,
        }).filter(([, v]) => v !== undefined),
      ),
      consent: ctx ? ctx.consent : true,
    };
  }

  /**
   * Sends one queued event. A refusal is logged and kept on the tracking id; a fault worth
   * retrying is thrown back to BullMQ until the last attempt, which logs it as failed.
   */
  async deliver(job: AdJob, final: boolean): Promise<'sent' | 'failed' | 'skipped'> {
    const d = await this.destinationRepo.findById(job.destinationId);
    if (!d?.enabled) return 'skipped';
    const platform = this.platforms.server(d.platform);
    const secret = this.destinations.secret(d);
    if (!platform || !secret) return 'skipped';
    // An order's purchase or refund goes to each tracking id once, even if queued again.
    if (
      job.order &&
      (await this.logs.exists({
        orderId: new Types.ObjectId(job.order.orderId),
        destinationId: d._id,
        event: job.order.name,
        status: 'sent',
      }))
    )
      return 'skipped';
    const event = job.event ?? (job.order ? await this.orderEvent(job.order) : null);
    if (!event || !platform.handles(event.name)) return 'skipped';
    const source: AdEventSource = job.order ? 'order' : event.test ? 'test' : 'browser';
    try {
      const detail = await platform.send(
        { publicId: d.publicId, secret, ...(d.testCode ? { testCode: d.testCode } : {}) },
        event,
      );
      await this.log(d, event, source, 'sent', detail);
      await this.destinations.noteDelivery(d._id, null);
      return 'sent';
    } catch (err) {
      if (!(err instanceof AdPlatformError)) throw err;
      if (err.retry && !final) throw err;
      await this.log(d, event, source, 'failed', err.message);
      await this.destinations.noteDelivery(d._id, err.message);
      return 'failed';
    }
  }

  private async log(
    d: AdDestinationDoc,
    e: AdEvent,
    source: AdEventSource,
    status: 'sent' | 'failed',
    detail: string,
  ) {
    await this.logs.create({
      destinationId: d._id,
      platform: d.platform,
      event: e.name,
      eventId: e.eventId,
      source,
      ...(e.orderId ? { orderId: new Types.ObjectId(e.orderId) } : {}),
      ...(e.orderNumber ? { orderNumber: e.orderNumber } : {}),
      status,
      detail: detail.slice(0, 300),
    });
  }

  /** "Send a test event" in Settings › Ad tracking: sent at once, with the test code. */
  async sendTest(id: string): Promise<{ ok: boolean; message: string }> {
    await this.limits.consume('ad-test:org', this.orgId());
    const d = await this.destinations.get(id);
    const desc = this.platforms.descriptor(d.platform);
    const platform = this.platforms.server(d.platform);
    if (!platform)
      throw AppError.unprocessable(
        'tracking_test_unavailable',
        `${desc.name} runs in the shopper’s browser only. Place a test order on your store and look for the conversion in Google Ads after a few hours.`,
      );
    if (!d.secretEnc)
      throw AppError.validation([{ path: 'secret', message: `Add the ${desc.secretLabel} first` }]);
    if (desc.testCodeLabel && !d.testCode)
      throw AppError.validation([
        {
          path: 'testCode',
          message: `Add the ${desc.testCodeLabel} from Events Manager › Test events, so the test is not counted as a real shopper`,
        },
      ]);
    const name: AdEventName = d.platform === 'ga4' ? 'Purchase' : 'ViewContent';
    const { currency } = await this.orgs.get(this.orgId());
    const event: AdEvent = {
      name,
      eventId: `test.${new Types.ObjectId().toHexString()}`,
      time: nowSec(),
      actionSource: 'website',
      currency,
      valueMinor: 100,
      items: [{ id: 'sellora-test', name: 'Sellora test event', quantity: 1, priceMinor: 100 }],
      user: {
        userAgent: 'Mozilla/5.0 (Sellora test event)',
        externalId: `test:${this.orgId()}`,
      },
      consent: true,
      test: true,
    };
    const result = await this.deliver(
      { orgId: this.orgId(), destinationId: d._id.toHexString(), event },
      true,
    );
    const last = await this.logs.findOne({ eventId: event.eventId });
    return { ok: result === 'sent', message: last?.detail ?? 'Nothing was sent.' };
  }

  /**
   * The purchase as the shopper's browser reports it on the receipt or thank-you page, with
   * the server's event id so each platform counts it once. Email and phone only hashed (for
   * Google Ads enhanced conversions); the receipt link never carries them in clear.
   */
  static browserPurchase(order: OrderDoc) {
    return {
      eventId: `purchase.${order._id.toHexString()}`,
      orderNumber: order.number,
      currency: order.currency,
      valueMinor: order.totalMinor,
      items: order.items.map((i) => ({
        id: i.productId.toHexString(),
        name: i.name,
        quantity: i.quantity,
        priceMinor: i.unitPriceMinor,
      })),
      hashedEmail: hashed(normEmail(order.customer.email)) ?? null,
      hashedPhone: hashed(e164(order.customer.phone ?? order.shippingAddress.phone)) ?? null,
    };
  }

  // ---------------------------------------------------------------- the log

  async recent(destinationId: string | undefined, limit = 50) {
    const filter =
      destinationId && Types.ObjectId.isValid(destinationId)
        ? { destinationId: new Types.ObjectId(destinationId) }
        : {};
    const rows = await this.logs.find(filter, { sort: { createdAt: -1 }, limit });
    return rows.map((r) => ({
      id: r._id.toHexString(),
      destinationId: r.destinationId.toHexString(),
      platform: r.platform,
      event: r.event,
      eventId: r.eventId,
      source: r.source,
      orderId: r.orderId?.toHexString() ?? null,
      orderNumber: r.orderNumber ?? null,
      status: r.status,
      detail: r.detail,
      at: r.createdAt.toISOString(),
    }));
  }

  /** Sent and failed server events per tracking id in the last 7 days. */
  async weekCounts(): Promise<Record<string, { sent: number; failed: number }>> {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const rows = await this.connection
      .collection('adeventlogs')
      .aggregate<{ _id: { d: Types.ObjectId; s: 'sent' | 'failed' }; n: number }>([
        { $match: { orgId: new Types.ObjectId(this.orgId()), createdAt: { $gte: since } } },
        { $group: { _id: { d: '$destinationId', s: '$status' }, n: { $sum: 1 } } },
      ])
      .toArray();
    const out: Record<string, { sent: number; failed: number }> = {};
    for (const r of rows) {
      const k = r._id.d.toHexString();
      out[k] ??= { sent: 0, failed: 0 };
      out[k][r._id.s] = r.n;
    }
    return out;
  }
}
