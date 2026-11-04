import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model, type QueryFilter } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError, type FieldError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { AppConfig } from '../../config/app-config.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import type { OrderDoc } from '../commerce/orders.service.js';
import { CustomerRepository, OrderRepository } from '../commerce/repositories.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { MAX_SMS_PARTS, smsLength } from '../sms/segments.js';
import { SmsService } from '../sms/sms.service.js';
import type { SmsSettingsDoc } from '../sms/repositories.js';
import type { SmsLanguage } from '../sms/templates.js';
import {
  AFTER_DELIVERY_DAYS,
  AFTER_DELIVERY_PLACEHOLDERS,
  AUTOMATION_GAP_MS,
  AUTOMATION_MAX_LATE_MS,
  CAMPAIGN_PLACEHOLDERS,
  DEFAULT_AUTOMATION_TEXTS,
  MAX_CAMPAIGN_TEXT_CHARS,
  RETRY_LATER_MS,
  SEND_WINDOW,
  WIN_BACK_DAYS,
  inSendWindow,
  nextSendTime,
  tomorrowMorning,
} from './campaign-rules.js';
import { composeMarketing, textLanguage, textProblems } from './compose.js';
import { MarketingLinksService, type LinkInput } from './links.service.js';
import {
  AutomationSendRepository,
  AutomationSettingsRepository,
  CampaignRecipientRepository,
  type AutomationSendDoc,
  type AutomationSettingsDoc,
} from './repositories.js';
import {
  AUTOMATION_KINDS,
  type Automation,
  type AutomationKind,
  type AutomationSend,
  type AutomationSettings,
  type AutomationSkip,
  type LinkChoice,
} from './schemas.js';

const DAY_MS = 24 * 3600_000;
/** How long one sweep holds a send before another may pick it up (a crash). */
const LEASE_MS = 10 * 60_000;
/** Sends one sweep looks at, in all businesses. */
const SEND_LIMIT = 200;
/** Businesses whose win-back customers one sweep plans. */
const PLAN_ORGS = 50;
/** Win-back customers planned per business per sweep (the rest on the next one). */
const PLAN_CUSTOMERS = 1000;
/** Stats on the automations page cover this many days. */
const STATS_DAYS = 30;

const PLACEHOLDERS: Record<AutomationKind, readonly string[]> = {
  after_delivery: Object.keys(AFTER_DELIVERY_PLACEHOLDERS),
  win_back: Object.keys(CAMPAIGN_PLACEHOLDERS),
};
const DAY_CHOICES: Record<AutomationKind, readonly number[]> = {
  after_delivery: AFTER_DELIVERY_DAYS,
  win_back: WIN_BACK_DAYS,
};
const DEFAULT_DAYS: Record<AutomationKind, number> = { after_delivery: 3, win_back: 60 };
/** The tag in the short link's tracking (`utm_campaign`). */
const UTM: Record<AutomationKind, string> = {
  after_delivery: 'after-delivery',
  win_back: 'win-back',
};
const KIND_LABEL: Record<AutomationKind, string> = {
  after_delivery: 'After delivery',
  win_back: 'Win back',
};

export interface AutomationPatch {
  enabled?: boolean;
  days?: number;
  text?: string;
  link?: LinkInput;
}

export interface AutomationsPatch {
  language?: SmsLanguage;
  after_delivery?: AutomationPatch;
  win_back?: AutomationPatch;
}

export type AutomationOutcome =
  'raced' | 'sent' | `skipped:${AutomationSkip}` | 'night' | 'gap' | 'daily_limit' | 'retry';

/**
 * The two texts that run by themselves (ADR 0019): a thank-you N days after delivery, and a
 * win-back text when a customer's last order turns N days old. Planned as AutomationSend
 * rows, sent by the worker sweep inside the sending hours. Must run inside a tenant scope,
 * except where a method says it crosses tenants.
 */
@Injectable()
export class AutomationsService {
  private readonly logger = new Logger(AutomationsService.name);

  constructor(
    private readonly settingsRepo: AutomationSettingsRepository,
    private readonly sends: AutomationSendRepository,
    private readonly recipients: CampaignRecipientRepository,
    @InjectModel('AutomationSettings') private readonly settingsModel: Model<AutomationSettings>,
    @InjectModel('AutomationSend') private readonly sendModel: Model<AutomationSend>,
    private readonly customers: CustomerRepository,
    private readonly orders: OrderRepository,
    private readonly links: MarketingLinksService,
    private readonly sms: SmsService,
    private readonly entitlements: EntitlementsService,
    private readonly orgs: OrgsService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  // ---------------------------------------------------------------- settings

  /** The business's automations, made with defaults on first use (both off). */
  async settings(): Promise<AutomationSettingsDoc> {
    const found = await this.settingsRepo.findOne({});
    if (found) return found;
    const org = await this.orgs.get(this.orgId());
    const language: SmsLanguage = org.locale === 'bn' ? 'bn' : 'en';
    const fresh = (kind: AutomationKind): Automation => ({
      enabled: false,
      days: DEFAULT_DAYS[kind],
      text: DEFAULT_AUTOMATION_TEXTS[language][kind],
      link: { kind: 'none' },
    });
    try {
      return await this.settingsRepo.create({
        language,
        after_delivery: fresh('after_delivery'),
        win_back: fresh('win_back'),
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      return (await this.settingsRepo.findOne({}))!;
    }
  }

  private sampleStop(): string {
    return `${this.config.get('WEB_APP_URL').replace(/\/$/, '')}/u/Ab12Cd34`;
  }

  private async sampleOrder(): Promise<string> {
    const org = await this.orgs.get(this.orgId());
    return `${org.settings?.orderNumberPrefix ?? 'SL'}-1042`;
  }

  /** The text with sample values and the stop link, and the parts it needs. */
  private async preview(text: string, link: LinkChoice, smsSettings: SmsSettingsDoc) {
    const language = textLanguage(text);
    const shop = (await this.sms.shopValues(smsSettings)).shop;
    const values = {
      name: language === 'bn' ? 'রহিম' : 'Rahim',
      shop,
      link: await this.links.previewUrl(link),
      order: await this.sampleOrder(),
    };
    const composed = composeMarketing(text, values, language, this.sampleStop());
    const length = smsLength(composed);
    return { text: composed, parts: length.parts, encoding: length.encoding, language };
  }

  private async problems(
    kind: AutomationKind,
    a: { text: string; link: LinkChoice; enabled: boolean },
    smsSettings: SmsSettingsDoc,
  ): Promise<FieldError[]> {
    const preview = await this.preview(a.text, a.link, smsSettings);
    return textProblems(a.text, {
      path: `${kind}.text`,
      placeholders: PLACEHOLDERS[kind],
      link: a.link,
      maxChars: MAX_CAMPAIGN_TEXT_CHARS,
      composed: preview.text,
      required: a.enabled,
    });
  }

  /** Why the saved link would not work now (the page went offline), or null. */
  private async linkProblem(link: LinkChoice): Promise<string | null> {
    if (link.kind === 'none') return null;
    try {
      await this.links.choose(linkInput(link));
      return null;
    } catch (err) {
      if (err instanceof AppError) {
        const errors = (err.details as { errors?: FieldError[] } | undefined)?.errors;
        return errors?.[0]?.message ?? err.message;
      }
      throw err;
    }
  }

  async get(now = new Date()) {
    return this.dto(await this.settings(), now);
  }

  private async dto(s: AutomationSettingsDoc, now: Date) {
    const smsSettings = await this.sms.settings();
    const since = new Date(now.getTime() - STATS_DAYS * DAY_MS);
    const [included, route, sendRows, orderRows] = await Promise.all([
      this.entitlements.hasModule(this.orgId(), 'marketing'),
      this.sms.resolveRoute(smsSettings),
      this.sends.aggregate<{ _id: { kind: AutomationKind; status: string }; n: number }>([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { kind: '$kind', status: '$status' }, n: { $sum: 1 } } },
      ]),
      this.sends.aggregate<{ _id: AutomationKind; count: number; revenueMinor: number }>([
        { $match: { 'order.at': { $gte: since } } },
        {
          $group: {
            _id: '$kind',
            count: { $sum: 1 },
            revenueMinor: { $sum: '$order.totalMinor' },
          },
        },
      ]),
    ]);
    const one = async (kind: AutomationKind) => {
      const a = s[kind];
      const [preview, clicks, messages, linkProblem, url] = await Promise.all([
        this.preview(a.text, a.link, smsSettings),
        this.links.clicks(a.link.code),
        this.sms.statsFor({ type: 'automation', id: kind }, since),
        this.linkProblem(a.link),
        a.link.code ? this.links.previewUrl(a.link) : Promise.resolve(null),
      ]);
      const count = (status: string) =>
        sendRows.find((r) => r._id.kind === kind && r._id.status === status)?.n ?? 0;
      const orders = orderRows.find((r) => r._id === kind);
      return {
        kind,
        enabled: a.enabled,
        days: a.days,
        dayChoices: DAY_CHOICES[kind],
        text: a.text,
        defaultText: DEFAULT_AUTOMATION_TEXTS[s.language][kind],
        placeholders: PLACEHOLDERS[kind].map((key) => ({
          key,
          label: AFTER_DELIVERY_PLACEHOLDERS[key as keyof typeof AFTER_DELIVERY_PLACEHOLDERS],
        })),
        link: {
          kind: a.link.kind,
          label: a.link.label ?? null,
          storeId: a.link.storeId?.toHexString() ?? null,
          targetId: a.link.targetId ?? null,
          path: a.link.path ?? null,
          url,
          problem: linkProblem,
          ...clicks,
        },
        enabledAt: a.enabledAt?.toISOString() ?? null,
        preview,
        last30Days: {
          planned: count('pending'),
          sent: count('sent'),
          skipped: count('skipped'),
          messages,
          orders: { count: orders?.count ?? 0, revenueMinor: orders?.revenueMinor ?? 0 },
        },
      };
    };
    return {
      included,
      language: s.language,
      sendWindow: SEND_WINDOW,
      gapHours: AUTOMATION_GAP_MS / 3600_000,
      maxLateDays: AUTOMATION_MAX_LATE_MS / DAY_MS,
      maxChars: MAX_CAMPAIGN_TEXT_CHARS,
      maxParts: MAX_SMS_PARTS,
      sms:
        'failure' in route
          ? { mode: smsSettings.mode, ready: false as const, message: route.message }
          : {
              mode: smsSettings.mode,
              ready: true as const,
              pricePerPartMinor: route.pricePerPart,
              currency: route.currency,
            },
      after_delivery: await one('after_delivery'),
      win_back: await one('win_back'),
    };
  }

  /** Changes one or both automations. Switching one on needs the `marketing` module. */
  async update(patch: AutomationsPatch, now = new Date()) {
    const s = await this.settings();
    const smsSettings = await this.sms.settings();
    const errors: FieldError[] = [];
    const set: Record<string, unknown> = {};
    const changes: Record<string, unknown> = {};
    if (patch.language && patch.language !== s.language) {
      set.language = patch.language;
      changes.language = patch.language;
    }
    for (const kind of AUTOMATION_KINDS) {
      const p = patch[kind];
      if (!p) continue;
      const current = s[kind];
      let link = current.link;
      if (p.link !== undefined) {
        try {
          link = await this.links.choose(p.link, `${kind}.link`);
        } catch (err) {
          const fieldErrors =
            err instanceof AppError
              ? (err.details as { errors?: FieldError[] } | undefined)?.errors
              : undefined;
          if (!fieldErrors) throw err;
          errors.push(...fieldErrors);
          continue;
        }
        // The short code stays while the link still goes to the same page.
        if (current.link.code && this.links.same(link, current.link)) link.code = current.link.code;
      }
      const next = {
        enabled: p.enabled ?? current.enabled,
        days: p.days ?? current.days,
        text: (p.text ?? current.text).trim(),
        link,
      };
      if (!DAY_CHOICES[kind].includes(next.days))
        errors.push({
          path: `${kind}.days`,
          message: `Choose ${DAY_CHOICES[kind].join(', ')} days`,
        });
      errors.push(...(await this.problems(kind, next, smsSettings)));
      const switchedOn = next.enabled && !current.enabled;
      if (switchedOn && !(await this.entitlements.hasModule(this.orgId(), 'marketing')))
        throw AppError.paymentRequired(
          'module_not_in_plan',
          'Automations are not in your plan. Upgrade to turn them on.',
        );
      set[kind] = {
        ...next,
        ...(switchedOn
          ? { enabledAt: now }
          : current.enabledAt
            ? { enabledAt: current.enabledAt }
            : {}),
      };
      if (kind === 'win_back' && switchedOn) set.winBackCheckedAt = now;
      if (next.enabled !== current.enabled) changes[`${kind}.enabled`] = next.enabled;
      if (next.days !== current.days) changes[`${kind}.days`] = next.days;
      if (next.text !== current.text) changes[`${kind}.text`] = true;
      if (!this.links.same(next.link, current.link)) changes[`${kind}.link`] = next.link.kind;
    }
    if (errors.length) throw AppError.validation(errors);
    if (!Object.keys(set).length) return this.dto(s, now);
    const updated = (await this.settingsRepo.findOneAndUpdate({ _id: s._id }, { $set: set }))!;
    // A switched-off automation sends nothing more; what was planned is skipped when due.
    if (Object.keys(changes).length)
      await this.audit.record({
        orgId: this.orgId(),
        action: 'automation.updated',
        target: { type: 'automation_settings', id: s._id.toHexString(), label: 'Automations' },
        metadata: changes,
      });
    return this.dto(updated, now);
  }

  // ---------------------------------------------------------------- planning

  /**
   * Plans the after-delivery text for an order that was just marked delivered (once per
   * order, however often it is marked). Returns whether one was planned.
   */
  async orderDelivered(order: OrderDoc, now = new Date()): Promise<boolean> {
    const s = await this.settingsRepo.findOne({});
    const a = s?.after_delivery;
    if (!a?.enabled) return false;
    const phone = order.customer.phone ?? order.shippingAddress.phone;
    if (!phone) return false;
    const due = new Date(now.getTime() + a.days * DAY_MS);
    try {
      await this.sends.create({
        kind: 'after_delivery',
        key: `after_delivery:${order._id.toHexString()}`,
        customerId: order.customerId,
        orderId: order._id,
        orderNumber: order.number,
        phone,
        name: order.customer.name ?? '',
        dueAt: due,
        firstDueAt: due,
        status: 'pending',
      });
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  /**
   * Plans win-back texts for customers whose last order turned N days old since the last
   * look (never before the automation was switched on). In every business: crosses tenants.
   */
  async planWinBack(now = new Date()): Promise<number> {
    const due = await this.settingsModel
      .find({ 'win_back.enabled': true }, { _id: 1, orgId: 1 }, { [CROSS_TENANT]: true })
      .sort({ winBackCheckedAt: 1 })
      .limit(PLAN_ORGS)
      .lean()
      .exec();
    let planned = 0;
    for (const row of due) {
      try {
        planned += await RequestContext.withTenant(
          row.orgId.toHexString(),
          () => this.planWinBackHere(now),
          { type: 'system', id: 'automations' },
        );
      } catch (err) {
        this.logger.error({ err, orgId: row.orgId.toHexString() }, 'Win-back planning failed');
      }
    }
    return planned;
  }

  /** planWinBack for the business in scope. */
  async planWinBackHere(now = new Date()): Promise<number> {
    const s = await this.settingsRepo.findOne({});
    const a = s?.win_back;
    if (!s || !a?.enabled) return 0;
    const span = a.days * DAY_MS;
    const enabledAt = a.enabledAt ?? now;
    const checked = s.winBackCheckedAt ?? enabledAt;
    const from = new Date(Math.max(checked.getTime(), enabledAt.getTime()) - span);
    const to = new Date(now.getTime() - span);
    if (from.getTime() >= to.getTime()) {
      await this.settingsRepo.updateOne({ _id: s._id }, { $set: { winBackCheckedAt: now } });
      return 0;
    }
    const found = await this.customers.find(
      {
        phone: { $type: 'string' },
        blocked: { $ne: true },
        'stats.lastOrderAt': { $gt: from, $lte: to },
      },
      {
        sort: { 'stats.lastOrderAt': 1 },
        limit: PLAN_CUSTOMERS,
        projection: { _id: 1, name: 1, phone: 1, stats: 1 },
      },
    );
    let planned = 0;
    for (const c of found) {
      const last = c.stats.lastOrderAt!;
      const dueAt = new Date(last.getTime() + span);
      try {
        await this.sends.create({
          kind: 'win_back',
          key: `win_back:${c._id.toHexString()}:${last.getTime()}`,
          customerId: c._id,
          phone: c.phone!,
          name: c.name,
          dueAt,
          firstDueAt: dueAt,
          status: 'pending',
        });
        planned += 1;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
    }
    // A full page: carry on from the last customer planned on the next sweep.
    const checkedAt =
      found.length === PLAN_CUSTOMERS
        ? new Date(found[found.length - 1]!.stats.lastOrderAt!.getTime() + span)
        : now;
    await this.settingsRepo.updateOne({ _id: s._id }, { $set: { winBackCheckedAt: checkedAt } });
    return planned;
  }

  // ---------------------------------------------------------------- sending

  /** Sends the automation texts that are due, in every business. Crosses tenants. */
  async sendDue(now = new Date()): Promise<Record<string, number>> {
    const due = await this.sendModel
      .find(
        { status: 'pending', dueAt: { $lte: now } },
        { _id: 1, orgId: 1 },
        { [CROSS_TENANT]: true },
      )
      .sort({ dueAt: 1 })
      .limit(SEND_LIMIT)
      .lean()
      .exec();
    const counts: Record<string, number> = {};
    for (const row of due) {
      let outcome: AutomationOutcome | 'error';
      try {
        outcome = await RequestContext.withTenant(
          row.orgId.toHexString(),
          () => this.deliver(row._id, now),
          { type: 'system', id: 'automations' },
        );
      } catch (err) {
        this.logger.error({ err, sendId: row._id.toHexString() }, 'Automation send failed');
        outcome = 'error';
        await RequestContext.withTenant(row.orgId.toHexString(), () =>
          this.sends.updateOne(
            { _id: row._id, status: 'pending' },
            { $set: { dueAt: new Date(now.getTime() + RETRY_LATER_MS) } },
          ),
        ).catch(() => undefined);
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return counts;
  }

  /** One planned text: skipped, moved on (night, the gap, today's limit) or handed to SMS. */
  async deliver(id: Types.ObjectId, now = new Date()): Promise<AutomationOutcome> {
    const send = await this.sends.findOneAndUpdate(
      { _id: id, status: 'pending', dueAt: { $lte: now } },
      { $set: { dueAt: new Date(now.getTime() + LEASE_MS) } },
    );
    if (!send) return 'raced';
    const skip = async (reason: AutomationSkip): Promise<AutomationOutcome> => {
      await this.sends.updateOne(
        { _id: send._id, status: 'pending' },
        { $set: { status: 'skipped', skip: reason } },
      );
      return `skipped:${reason}`;
    };
    const later = async (at: Date, outcome: AutomationOutcome): Promise<AutomationOutcome> => {
      if (at.getTime() - send.firstDueAt.getTime() > AUTOMATION_MAX_LATE_MS) return skip('late');
      await this.sends.updateOne({ _id: send._id, status: 'pending' }, { $set: { dueAt: at } });
      return outcome;
    };

    const s = await this.settingsRepo.findOne({});
    const a = s?.[send.kind];
    if (!s || !a?.enabled) return skip('off');
    if (!(await this.entitlements.hasModule(this.orgId(), 'marketing'))) return skip('not_in_plan');
    if (now.getTime() - send.firstDueAt.getTime() > AUTOMATION_MAX_LATE_MS) return skip('late');

    const still = await this.stillWanted(send);
    if (still) return skip(still);

    const org = await this.orgs.get(this.orgId());
    if (!inSendWindow(now, org.timezone)) return later(nextSendTime(now, org.timezone), 'night');
    const last = await this.lastMarketingText(send.phone);
    if (last && now.getTime() - last.getTime() < AUTOMATION_GAP_MS)
      return later(nextSendTime(new Date(last.getTime() + AUTOMATION_GAP_MS), org.timezone), 'gap');

    const smsSettings = await this.sms.settings();
    const route = await this.sms.resolveRoute(smsSettings);
    if ('failure' in route) return later(new Date(now.getTime() + RETRY_LATER_MS), 'retry');
    if (this.sms.dailyLimit(smsSettings) - (await this.sms.sentToday()) <= 0)
      return later(tomorrowMorning(now, org.timezone), 'daily_limit');

    let link: string | null = null;
    if (a.link.kind !== 'none') {
      if (await this.linkProblem(a.link)) return skip('link_gone');
      const made = await this.links.ensure(
        a.link,
        { type: 'automation', id: send.kind },
        UTM[send.kind],
      );
      if (!made) return skip('link_gone');
      if (made.code !== a.link.code)
        await this.settingsRepo.updateOne(
          { _id: s._id, [`${send.kind}.link.path`]: a.link.path },
          { $set: { [`${send.kind}.link.code`]: made.code } },
        );
      link = made.url;
    }
    const language = textLanguage(a.text);
    const text = composeMarketing(
      a.text,
      {
        name: send.name,
        shop: (await this.sms.shopValues(smsSettings)).shop,
        ...(link ? { link } : {}),
        ...(send.orderNumber ? { order: send.orderNumber } : {}),
      },
      language,
      await this.sms.optOutUrl(send.phone),
    );
    const result = await this.sms.enqueue({
      to: send.phone,
      text,
      purpose: 'automation',
      key: `auto:${send.key}`,
      ref: { type: 'automation', id: send.kind, label: KIND_LABEL[send.kind] },
    });
    if (result.message === null) {
      if (result.skipped === 'opted_out') return skip('opted_out');
      return later(new Date(now.getTime() + RETRY_LATER_MS), 'retry');
    }
    await this.sends.updateOne(
      { _id: send._id, status: 'pending' },
      {
        $set: { status: 'sent', messageId: result.message._id.toHexString(), sentAt: now },
      },
    );
    return 'sent';
  }

  /** Why a planned text should not go any more, or null when it still should. */
  private async stillWanted(send: AutomationSendDoc): Promise<AutomationSkip | null> {
    if (send.kind === 'after_delivery') {
      const order = send.orderId ? await this.orders.findById(send.orderId) : null;
      if (!order || order.status !== 'delivered') return 'returned';
      const customer = await this.customers.findById(order.customerId);
      if (customer?.blocked) return 'blocked';
      return null;
    }
    const customer = send.customerId ? await this.customers.findById(send.customerId) : null;
    if (!customer?.phone) return 'no_phone';
    if (customer.blocked) return 'blocked';
    const planned = Number(send.key.split(':').pop());
    if (customer.stats.lastOrderAt?.getTime() !== planned) return 'ordered_again';
    return null;
  }

  /** When the number last got a campaign or automation text from this business. */
  private async lastMarketingText(phone: string): Promise<Date | null> {
    const [recipient, sent] = await Promise.all([
      this.recipients.findOne(
        { phone, status: 'queued' },
        { queuedAt: 1 },
        { sort: { queuedAt: -1 } },
      ),
      this.sends.findOne({ phone, status: 'sent' }, { sentAt: 1 }, { sort: { sentAt: -1 } }),
    ]);
    const times = [recipient?.queuedAt, sent?.sentAt]
      .filter((d): d is Date => d instanceof Date)
      .map((d) => d.getTime());
    return times.length ? new Date(Math.max(...times)) : null;
  }

  // ---------------------------------------------------------------- reading

  /** The texts planned, sent and skipped, newest first. */
  async listSends(q: {
    kind?: AutomationKind;
    status?: AutomationSend['status'];
    limit: number;
    cursor?: string;
  }) {
    const filter: QueryFilter<AutomationSend> = {};
    if (q.kind) filter.kind = q.kind;
    if (q.status) filter.status = q.status;
    const page = await this.sends.paginate(filter, {
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    const messages = new Map(
      (
        await this.sms.findMessages(page.items.map((r) => r.messageId).filter(Boolean) as string[])
      ).map((m) => [m._id.toHexString(), m]),
    );
    return {
      ...page,
      items: page.items.map((r) => {
        const m = r.messageId ? messages.get(r.messageId) : undefined;
        return {
          id: r._id.toHexString(),
          kind: r.kind,
          customerId: r.customerId?.toHexString() ?? null,
          orderId: r.orderId?.toHexString() ?? null,
          orderNumber: r.orderNumber ?? null,
          name: r.name,
          phone: r.phone,
          status: r.status,
          skip: r.skip ?? null,
          dueAt: r.dueAt.toISOString(),
          sentAt: r.sentAt?.toISOString() ?? null,
          message: m
            ? {
                id: r.messageId!,
                status: m.status,
                parts: m.parts,
                priceMinor: m.priceMinor,
                currency: m.currency,
                error: m.error ?? null,
              }
            : null,
          order: r.order ? { ...r.order, at: r.order.at.toISOString() } : null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    };
  }
}

function linkInput(l: LinkChoice): LinkInput {
  return {
    kind: l.kind,
    ...(l.storeId ? { storeId: l.storeId.toHexString() } : {}),
    ...(l.targetId ? { targetId: l.targetId } : {}),
  };
}
