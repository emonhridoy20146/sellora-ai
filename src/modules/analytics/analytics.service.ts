import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context.js';
import { AI_ACTOR } from '../ai/agent/ai-replies.service.js';
import { VOICE_NOTE_FEATURE } from '../ai/voice-notes/voice-notes.service.js';
import { AiUsageRepository } from '../billing/credits.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import type { FeatureModule } from '../billing/feature-modules.js';
import { CartRepository } from '../carts/repositories.js';
import { OrderRepository } from '../commerce/repositories.js';
import type { OrderSource } from '../commerce/schemas.js';
import { FraudService } from '../fraud/fraud.service.js';
import { ChannelRepository, MessageRepository } from '../inbox/repositories.js';
import type { ChannelType } from '../inbox/schemas.js';
import { OrgsService } from '../orgs/orgs.service.js';

/**
 * What a person would spend typing one chat reply, for the "time saved" estimate (ADR 0026).
 * Shown next to the number, so the business sees how it was worked out.
 */
export const MINUTES_PER_AI_REPLY = 2;
/** Cancelled orders whose numbers are checked for risk, newest first, per request. */
const RISK_CHECK_LIMIT = 500;
const RISK_BATCH = 100;
const TOP_PRODUCTS = 5;
/** Orders that count as sales: not cancelled and not sent back. */
const LOST = ['cancelled', 'returned'];
/** Messages a customer saw or wrote (not internal notes or system lines). */
const CHAT_TYPES = ['text', 'image', 'audio', 'file'];

export interface AnalyticsRange {
  from: Date;
  to: Date;
}

interface Money {
  count: number;
  valueMinor: number;
}

export interface AnalyticsOverview {
  range: { from: string; to: string; timezone: string; currency: string };
  /** What Sellora's automation did for the business. A part is null when the plan lacks it. */
  value: {
    ai: {
      /** Replies the AI sales agent sent. */
      replies: number;
      /** Chats it replied in, and of those, chats no one from the team had to answer. */
      conversations: number;
      answeredByAiOnly: number;
      voiceNotes: number;
      /** replies × minutesPerReply: an estimate, labelled as one. */
      minutesSaved: number;
      minutesPerReply: number;
      /** AI credits charged in the period (all AI features), in the wallet currency. */
      spentMinor: number;
      /** Orders the agent placed (null without orders in the plan). */
      orders: Money | null;
    } | null;
    /** Abandoned carts that became orders after a reminder. */
    carts: Money | null;
    /** Cancelled before shipping, from numbers the fraud check now rates high risk. */
    riskyOrders: { stopped: number; deliveryChargeMinor: number; checked: number } | null;
  };
  inbox: {
    /** Chats with a customer message in the period. */
    conversations: number;
    customerMessages: number;
    aiReplies: number;
    teamReplies: number;
    /** Median time from a customer's message to the next reply, in seconds. */
    replySeconds: { ai: number | null; team: number | null };
    byChannel: { channelType: ChannelType; conversations: number }[];
    byDay: { date: string; customerMessages: number; aiReplies: number; teamReplies: number }[];
  } | null;
  sales: {
    orders: number;
    valueMinor: number;
    averageMinor: number;
    cancelled: number;
    returned: number;
    delivered: number;
    bySource: { source: OrderSource; orders: number; valueMinor: number }[];
    byDay: { date: string; orders: number; valueMinor: number; aiOrders: number }[];
    topProducts: { productId: string; name: string; quantity: number; valueMinor: number }[];
  } | null;
}

/**
 * First analytics and the value dashboard (ADR 0026): read-only aggregations over the
 * business's own messages, orders, carts and AI usage for one period, bucketed by day in the
 * business's time zone. Every read goes through tenant-scoped repositories.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly orgs: OrgsService,
    private readonly entitlements: EntitlementsService,
    private readonly messages: MessageRepository,
    private readonly channels: ChannelRepository,
    private readonly orders: OrderRepository,
    private readonly carts: CartRepository,
    private readonly usage: AiUsageRepository,
    private readonly fraud: FraudService,
  ) {}

  async overview(range: AnalyticsRange): Promise<AnalyticsOverview> {
    const orgId = RequestContext.tenant()!.orgId;
    const [org, ent] = await Promise.all([this.orgs.get(orgId), this.entitlements.forOrg(orgId)]);
    const has = (m: FeatureModule) => ent.modules.includes(m);
    const tz = org.timezone;
    const ctx = { ...range, tz, currency: org.currency };

    const [inbox, sales, aiOrders, ai, carts, riskyOrders] = await Promise.all([
      has('inbox') ? this.inbox(ctx) : null,
      has('commerce') ? this.sales(ctx) : null,
      has('commerce') && has('ai_agent') ? this.aiOrders(ctx) : null,
      has('ai_agent') ? this.aiWork(ctx) : null,
      has('marketing') && has('commerce') ? this.recoveredCarts(ctx) : null,
      has('fraud') && has('commerce') ? this.riskyOrders(ctx) : null,
    ]);

    return {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        timezone: tz,
        currency: org.currency,
      },
      value: {
        ai: ai ? { ...ai, orders: aiOrders } : null,
        carts,
        riskyOrders,
      },
      inbox,
      sales,
    };
  }

  // ---------------------------------------------------------------- inbox

  private async inbox(c: Ctx): Promise<NonNullable<AnalyticsOverview['inbox']>> {
    const inRange = { createdAt: { $gte: c.from, $lt: c.to }, type: { $in: CHAT_TYPES } };
    const day = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: c.tz } };
    const [[row], channels] = await Promise.all([
      this.messages.aggregate<{
        byDay: { _id: { d: string; s: string }; n: number }[];
        conversations: { _id: { id: unknown; channelId: unknown } }[];
      }>([
        { $match: inRange },
        {
          $facet: {
            byDay: [{ $group: { _id: { d: day, s: '$sender.type' }, n: { $sum: 1 } } }],
            conversations: [
              { $match: { direction: 'in' } },
              { $group: { _id: { id: '$conversationId', channelId: '$channelId' } } },
            ],
          },
        },
      ]),
      this.channels.find({}),
    ]);
    const replySeconds = await this.replySeconds(c);

    const days = new Map<
      string,
      { customerMessages: number; aiReplies: number; teamReplies: number }
    >();
    let customerMessages = 0;
    let aiReplies = 0;
    let teamReplies = 0;
    for (const r of row?.byDay ?? []) {
      const d = days.get(r._id.d) ?? { customerMessages: 0, aiReplies: 0, teamReplies: 0 };
      if (r._id.s === 'contact') {
        d.customerMessages += r.n;
        customerMessages += r.n;
      } else if (r._id.s === 'ai') {
        d.aiReplies += r.n;
        aiReplies += r.n;
      } else if (r._id.s === 'user') {
        d.teamReplies += r.n;
        teamReplies += r.n;
      }
      days.set(r._id.d, d);
    }

    const typeOf = new Map(channels.map((ch) => [ch._id.toHexString(), ch.type]));
    const perType = new Map<ChannelType, number>();
    for (const conv of row?.conversations ?? []) {
      const type = typeOf.get(String(conv._id.channelId));
      if (type) perType.set(type, (perType.get(type) ?? 0) + 1);
    }

    return {
      conversations: row?.conversations.length ?? 0,
      customerMessages,
      aiReplies,
      teamReplies,
      replySeconds,
      byChannel: [...perType]
        .map(([channelType, conversations]) => ({ channelType, conversations }))
        .sort((a, b) => b.conversations - a.conversations),
      byDay: [...days]
        .map(([date, v]) => ({ date, ...v }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  /**
   * Median seconds from a customer's message to the reply that followed it, for replies by
   * the AI and by the team. Each reply is measured against the message just before it in the
   * same chat, so only replies that answered a customer count.
   */
  private async replySeconds(c: Ctx): Promise<{ ai: number | null; team: number | null }> {
    const rows = await this.messages.aggregate<{ _id: string; median: number | null }>([
      { $match: { createdAt: { $gte: c.from, $lt: c.to }, type: { $in: CHAT_TYPES } } },
      {
        $setWindowFields: {
          partitionBy: '$conversationId',
          sortBy: { createdAt: 1 },
          output: {
            prevDirection: { $shift: { output: '$direction', by: -1 } },
            prevAt: { $shift: { output: '$createdAt', by: -1 } },
          },
        },
      },
      { $match: { direction: 'out', prevDirection: 'in', 'sender.type': { $in: ['ai', 'user'] } } },
      {
        $group: {
          _id: '$sender.type',
          median: {
            $median: {
              input: { $divide: [{ $subtract: ['$createdAt', '$prevAt'] }, 1000] },
              method: 'approximate',
            },
          },
        },
      },
    ]);
    const of = (who: string) => {
      const m = rows.find((r) => r._id === who)?.median;
      return m === undefined || m === null ? null : Math.round(m);
    };
    return { ai: of('ai'), team: of('user') };
  }

  // ---------------------------------------------------------------- AI

  private async aiWork(c: Ctx) {
    const [[messages], [usage]] = await Promise.all([
      this.messages.aggregate<{ replies: number; conversations: number; aiOnly: number }>([
        {
          $match: {
            createdAt: { $gte: c.from, $lt: c.to },
            direction: 'out',
            type: { $in: CHAT_TYPES },
            'sender.type': { $in: ['ai', 'user'] },
          },
        },
        {
          $group: {
            _id: '$conversationId',
            ai: { $sum: { $cond: [{ $eq: ['$sender.type', 'ai'] }, 1, 0] } },
            team: { $sum: { $cond: [{ $eq: ['$sender.type', 'user'] }, 1, 0] } },
          },
        },
        { $match: { ai: { $gt: 0 } } },
        {
          $group: {
            _id: null,
            replies: { $sum: '$ai' },
            conversations: { $sum: 1 },
            aiOnly: { $sum: { $cond: [{ $eq: ['$team', 0] }, 1, 0] } },
          },
        },
      ]),
      this.usage.aggregate<{ spentMinor: number; voiceNotes: number }>([
        {
          $match: {
            status: 'settled',
            currency: c.currency,
            settledAt: { $gte: c.from, $lt: c.to },
          },
        },
        {
          $group: {
            _id: null,
            spentMinor: { $sum: { $subtract: ['$billedMinor', '$shortfallMinor'] } },
            voiceNotes: {
              $sum: { $cond: [{ $eq: ['$feature', VOICE_NOTE_FEATURE] }, 1, 0] },
            },
          },
        },
      ]),
    ]);
    const replies = messages?.replies ?? 0;
    return {
      replies,
      conversations: messages?.conversations ?? 0,
      answeredByAiOnly: messages?.aiOnly ?? 0,
      voiceNotes: usage?.voiceNotes ?? 0,
      minutesSaved: replies * MINUTES_PER_AI_REPLY,
      minutesPerReply: MINUTES_PER_AI_REPLY,
      spentMinor: usage?.spentMinor ?? 0,
    };
  }

  private async aiOrders(c: Ctx): Promise<Money> {
    const [row] = await this.orders.aggregate<Money>([
      {
        $match: {
          placedAt: { $gte: c.from, $lt: c.to },
          currency: c.currency,
          status: { $nin: LOST },
          'history.0.actor.id': AI_ACTOR.id,
        },
      },
      { $group: { _id: null, count: { $sum: 1 }, valueMinor: { $sum: '$totalMinor' } } },
    ]);
    return { count: row?.count ?? 0, valueMinor: row?.valueMinor ?? 0 };
  }

  // ---------------------------------------------------------------- sales

  private async sales(c: Ctx): Promise<NonNullable<AnalyticsOverview['sales']>> {
    const counted = { status: { $nin: LOST }, currency: c.currency };
    const day = { $dateToString: { format: '%Y-%m-%d', date: '$placedAt', timezone: c.tz } };
    const [row] = await this.orders.aggregate<{
      statuses: { _id: string; n: number }[];
      bySource: { _id: OrderSource; orders: number; valueMinor: number }[];
      byDay: { _id: string; orders: number; valueMinor: number; aiOrders: number }[];
      top: { _id: unknown; name: string; quantity: number; valueMinor: number }[];
    }>([
      { $match: { placedAt: { $gte: c.from, $lt: c.to } } },
      {
        $facet: {
          statuses: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
          bySource: [
            { $match: counted },
            {
              $group: {
                _id: '$source',
                orders: { $sum: 1 },
                valueMinor: { $sum: '$totalMinor' },
              },
            },
            { $sort: { valueMinor: -1 } },
          ],
          byDay: [
            { $match: counted },
            {
              $group: {
                _id: day,
                orders: { $sum: 1 },
                valueMinor: { $sum: '$totalMinor' },
                aiOrders: {
                  $sum: {
                    $cond: [
                      { $eq: [{ $arrayElemAt: ['$history.actor.id', 0] }, AI_ACTOR.id] },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
            { $sort: { _id: 1 } },
          ],
          top: [
            { $match: counted },
            { $unwind: '$items' },
            {
              $group: {
                _id: '$items.productId',
                name: { $first: '$items.name' },
                quantity: { $sum: '$items.quantity' },
                valueMinor: { $sum: '$items.totalMinor' },
              },
            },
            { $sort: { valueMinor: -1, quantity: -1 } },
            { $limit: TOP_PRODUCTS },
          ],
        },
      },
    ]);
    const status = (s: string) => row?.statuses.find((x) => x._id === s)?.n ?? 0;
    const orders = (row?.byDay ?? []).reduce((n, d) => n + d.orders, 0);
    const valueMinor = (row?.byDay ?? []).reduce((n, d) => n + d.valueMinor, 0);
    return {
      orders,
      valueMinor,
      averageMinor: orders ? Math.round(valueMinor / orders) : 0,
      cancelled: status('cancelled'),
      returned: status('returned'),
      delivered: status('delivered'),
      bySource: (row?.bySource ?? []).map((s) => ({
        source: s._id,
        orders: s.orders,
        valueMinor: s.valueMinor,
      })),
      byDay: (row?.byDay ?? []).map((d) => ({
        date: d._id,
        orders: d.orders,
        valueMinor: d.valueMinor,
        aiOrders: d.aiOrders,
      })),
      topProducts: (row?.top ?? []).map((p) => ({
        productId: String(p._id),
        name: p.name,
        quantity: p.quantity,
        valueMinor: p.valueMinor,
      })),
    };
  }

  // ---------------------------------------------------------------- marketing and fraud

  private async recoveredCarts(c: Ctx): Promise<Money> {
    const [row] = await this.carts.aggregate<Money>([
      {
        $match: {
          status: 'ordered',
          recovered: true,
          'order.at': { $gte: c.from, $lt: c.to },
        },
      },
      { $group: { _id: null, count: { $sum: 1 }, valueMinor: { $sum: '$order.totalMinor' } } },
    ]);
    return { count: row?.count ?? 0, valueMinor: row?.valueMinor ?? 0 };
  }

  /**
   * Orders cancelled before a parcel was booked, whose phone number the fraud check rates
   * high risk today: delivery charges a return would likely have wasted. The newest
   * RISK_CHECK_LIMIT are checked.
   */
  private async riskyOrders(c: Ctx) {
    const cancelled = await this.orders.find(
      {
        placedAt: { $gte: c.from, $lt: c.to },
        status: 'cancelled',
        'customer.phone': { $type: 'string' },
        'history.status': { $ne: 'shipped' },
      },
      { sort: { placedAt: -1 }, limit: RISK_CHECK_LIMIT },
    );
    const high = new Set<string>();
    const phones = [...new Set(cancelled.map((o) => o.customer.phone!))];
    for (let i = 0; i < phones.length; i += RISK_BATCH) {
      // A failing check leaves those numbers uncounted rather than failing the whole report.
      const { items } = await this.fraud
        .batch(phones.slice(i, i + RISK_BATCH))
        .catch((err: unknown) => {
          this.logger.warn(`Risk check for the value dashboard failed: ${String(err)}`);
          return { items: [] as { phone: string; level: string }[] };
        });
      for (const it of items) if (it.level === 'high') high.add(it.phone);
    }
    // Orders keep numbers in the form the fraud check returns (normalised when saved).
    const stopped = cancelled.filter((o) => high.has(o.customer.phone!));
    return {
      stopped: stopped.length,
      deliveryChargeMinor: stopped.reduce((n, o) => n + o.deliveryChargeMinor, 0),
      checked: cancelled.length,
    };
  }
}

interface Ctx extends AnalyticsRange {
  tz: string;
  currency: string;
}
