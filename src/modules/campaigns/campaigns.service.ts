import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model, type QueryFilter } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError, type FieldError } from '../../common/errors/app-error.js';
import type { Page } from '../../common/pagination/cursor.js';
import { normalizePhone } from '../../common/validation/schemas.js';
import { AppConfig } from '../../config/app-config.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { MailService } from '../../infra/mail/mail.service.js';
import { mailTemplates } from '../../infra/mail/templates.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { WalletService } from '../billing/wallet.service.js';
import type { OrderDoc } from '../commerce/orders.service.js';
import { CustomerRepository } from '../commerce/repositories.js';
import { CUSTOMER_SOURCES } from '../commerce/schemas.js';
import { landingStatus, type LandingPage } from '../landing-pages/schemas.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { MAX_SMS_PARTS, smsLength } from '../sms/segments.js';
import { SmsService, type SmsEnqueueResult } from '../sms/sms.service.js';
import type { SmsSettingsDoc } from '../sms/repositories.js';
import type { SmsMessage } from '../sms/schemas.js';
import { canReach } from '../sms/sms.types.js';
import { type SmsLanguage } from '../sms/templates.js';
import { formatMoney } from '../../common/money/money.js';
import { StoreRepository } from '../stores/repositories.js';
import { StoreLinksService } from '../stores/store-links.service.js';
import { UsersService } from '../users/users.service.js';
import {
  CAMPAIGN_BATCH,
  CAMPAIGN_PLACEHOLDERS,
  MAX_CAMPAIGN_TESTS,
  MAX_CAMPAIGN_TEXT_CHARS,
  ORDER_WINDOW_MS,
  RETRY_LATER_MS,
  SEND_WINDOW,
  audienceFilter,
  inSendWindow,
  nextSendTime,
  tomorrowMorning,
  utmName,
  type CampaignAudience,
} from './campaign-rules.js';
import { composeMarketing, textLanguage, textProblems } from './compose.js';
import { MarketingLinksService, type LinkInput } from './links.service.js';
import {
  AutomationSendRepository,
  CampaignRecipientRepository,
  CampaignRepository,
  type CampaignDoc,
  type CampaignRecipientDoc,
} from './repositories.js';
import type {
  Campaign,
  CampaignPause,
  CampaignRecipient,
  CampaignStatus,
  LinkChoice,
} from './schemas.js';

const PLACEHOLDER_KEYS = Object.keys(CAMPAIGN_PLACEHOLDERS);
/** Opted-out numbers live in the SMS module's collection (ADR 0017). */
const OPT_OUT_COLLECTION = 'smsoptouts';
const BD_MOBILE = '^\\+8801[3-9][0-9]{8}$';
/** How long one sweep may hold a campaign before another may pick it up (a crash). */
const LEASE_MS = 10 * 60_000;
/** The next batch of a campaign that is sending. */
const BATCH_EVERY_MS = 20_000;
/** Campaigns the sweep looks at in one run. */
const SWEEP_LIMIT = 20;
/** Scheduling further ahead than this is refused. */
const MAX_SCHEDULE_MS = 60 * 24 * 3600_000;
/** A schedule must leave staff this long to change their mind. */
const MIN_SCHEDULE_MS = 5 * 60_000;

/** A message that was not refused counts for orders after a campaign (as for carts). */
export const COUNTED_STATUSES: ReadonlySet<SmsMessage['status']> = new Set([
  'queued',
  'sending',
  'sent',
  'delivered',
  'unknown',
]);

export interface CampaignInput {
  name?: string;
  text?: string;
  audience?: CampaignAudience;
  link?: LinkInput;
}

export type CampaignOutcome =
  | 'raced'
  | 'started'
  | 'batch'
  | 'finished'
  | `paused:${CampaignPause}`
  | 'night'
  | 'daily_limit'
  | 'empty';

/**
 * SMS campaigns (ADR 0019): drafts, the audience count, test sends, starting now or at a
 * time, paced batches through SmsService, pause and cancel, and the orders that came after.
 * Must run inside a tenant scope, except where a method says it crosses tenants.
 */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly recipients: CampaignRecipientRepository,
    private readonly automationSends: AutomationSendRepository,
    @InjectModel('Campaign') private readonly campaignModel: Model<Campaign>,
    @InjectModel('CampaignRecipient') private readonly recipientModel: Model<CampaignRecipient>,
    @InjectModel('LandingPage') private readonly landingModel: Model<LandingPage>,
    private readonly customers: CustomerRepository,
    private readonly links: MarketingLinksService,
    private readonly stores: StoreRepository,
    private readonly storeLinks: StoreLinksService,
    private readonly sms: SmsService,
    private readonly wallet: WalletService,
    private readonly entitlements: EntitlementsService,
    private readonly orgs: OrgsService,
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private async requireModule(): Promise<void> {
    if (!(await this.entitlements.hasModule(this.orgId(), 'marketing')))
      throw AppError.paymentRequired(
        'module_not_in_plan',
        'SMS campaigns are not in your plan. Upgrade to send them.',
      );
  }

  // ---------------------------------------------------------------- texts

  private sampleStop(): string {
    return `${this.config.get('WEB_APP_URL').replace(/\/$/, '')}/u/Ab12Cd34`;
  }

  /** {name} {shop} {link} with made-up values, for previews and the length check. */
  async samples(link: LinkChoice, smsSettings?: SmsSettingsDoc) {
    const s = smsSettings ?? (await this.sms.settings());
    const shop = (await this.sms.shopValues(s)).shop;
    const url = await this.links.previewUrl(link);
    return {
      en: { name: 'Rahim', shop, link: url },
      bn: { name: 'রহিম', shop, link: url },
    };
  }

  /** The text with sample values and the stop link, and the parts it needs. */
  async preview(text: string, link: LinkChoice, smsSettings?: SmsSettingsDoc) {
    const language = textLanguage(text);
    const samples = await this.samples(link, smsSettings);
    const composed = composeMarketing(text, samples[language], language, this.sampleStop());
    const length = smsLength(composed);
    return { text: composed, parts: length.parts, encoding: length.encoding, language };
  }

  private async problems(c: { text: string; link: LinkChoice }, required: boolean) {
    const preview = await this.preview(c.text, c.link);
    return textProblems(c.text, {
      path: 'text',
      placeholders: PLACEHOLDER_KEYS,
      link: c.link,
      maxChars: MAX_CAMPAIGN_TEXT_CHARS,
      composed: preview.text,
      required,
    });
  }

  // ---------------------------------------------------------------- what the editor needs

  /** Stores, live landing pages, tags, the SMS route, wallet cash and today's limit. */
  async options() {
    const [org, smsSettings, stores, pages, tags, balance, included] = await Promise.all([
      this.orgs.get(this.orgId()),
      this.sms.settings(),
      this.stores.find({}, { sort: { _id: 1 } }),
      this.landingModel
        .find({ orgId: new Types.ObjectId(this.orgId()), published: { $exists: true } })
        .sort({ _id: -1 })
        .limit(100)
        .lean()
        .exec(),
      this.customers.aggregate<{ _id: string }>([
        { $match: { tags: { $exists: true, $ne: [] } } },
        { $unwind: '$tags' },
        { $group: { _id: '$tags', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 100 },
      ]),
      this.wallet.balance(),
      this.entitlements.hasModule(this.orgId(), 'marketing'),
    ]);
    const route = await this.sms.resolveRoute(smsSettings);
    const sentToday = await this.sms.sentToday();
    const limit = this.sms.dailyLimit(smsSettings);
    return {
      included,
      timezone: org.timezone,
      currency: org.currency,
      stores: stores.map((s) => ({
        id: s._id.toHexString(),
        name: s.name,
        url: this.storeLinks.url(s),
        status: s.status,
      })),
      landingPages: pages
        .filter((p) => landingStatus(p) === 'live')
        .map((p) => ({
          id: p._id.toHexString(),
          name: p.name,
          slug: p.slug,
          storeId: p.storeId.toHexString(),
        })),
      tags: tags.map((t) => t._id),
      sources: CUSTOMER_SOURCES,
      placeholders: PLACEHOLDER_KEYS.map((key) => ({
        key,
        label: CAMPAIGN_PLACEHOLDERS[key as keyof typeof CAMPAIGN_PLACEHOLDERS],
      })),
      maxChars: MAX_CAMPAIGN_TEXT_CHARS,
      maxParts: MAX_SMS_PARTS,
      maxTests: MAX_CAMPAIGN_TESTS,
      sendWindow: SEND_WINDOW,
      stopSuffix: {
        en: ` Stop: ${this.sampleStop()}`,
        bn: ` বন্ধ করতে: ${this.sampleStop()}`,
      },
      sampleNames: { en: 'Rahim', bn: 'রহিম' },
      shopName: (await this.sms.shopValues(smsSettings)).shop,
      sms:
        'failure' in route
          ? { mode: smsSettings.mode, ready: false as const, message: route.message }
          : {
              mode: smsSettings.mode,
              ready: true as const,
              providerName: route.provider.descriptor.name,
              pricePerPartMinor: route.pricePerPart,
              currency: route.currency,
              reach: route.provider.descriptor.reach,
            },
      wallet: { cashMinor: balance.withdrawableMinor, currency: balance.currency },
      daily: { limit, sentToday, left: Math.max(0, limit - sentToday) },
    };
  }

  // ---------------------------------------------------------------- audience

  /**
   * Who an audience reaches now: customers that match, those who asked to stop, and those
   * the SMS route cannot reach. `recipients` is what a campaign would send.
   */
  async count(audience: CampaignAudience, now = new Date()) {
    const smsSettings = await this.sms.settings();
    const route = await this.sms.resolveRoute(smsSettings);
    const bdOnly = !('failure' in route) && route.provider.descriptor.reach === 'bd_mobile';
    const orgId = new Types.ObjectId(this.orgId());
    const [row] = await this.customers.aggregate<{
      customers: number;
      optedOut: number;
      unreachable: number;
    }>([
      { $match: audienceFilter(audience, now) },
      {
        $lookup: {
          from: OPT_OUT_COLLECTION,
          let: { phone: '$phone' },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $eq: ['$orgId', orgId] }, { $eq: ['$phone', '$$phone'] }] },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: 'stop',
        },
      },
      {
        $group: {
          _id: null,
          customers: { $sum: 1 },
          optedOut: { $sum: { $cond: [{ $gt: [{ $size: '$stop' }, 0] }, 1, 0] } },
          unreachable: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: [{ $size: '$stop' }, 0] },
                    bdOnly
                      ? { $not: [{ $regexMatch: { input: '$phone', regex: BD_MOBILE } }] }
                      : false,
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);
    const customers = row?.customers ?? 0;
    const optedOut = row?.optedOut ?? 0;
    const unreachable = row?.unreachable ?? 0;
    return { customers, optedOut, unreachable, recipients: customers - optedOut - unreachable };
  }

  // ---------------------------------------------------------------- drafts

  private async normalise(input: CampaignInput, current?: CampaignDoc) {
    const link =
      input.link !== undefined
        ? await this.links.choose(input.link)
        : (current?.link ?? { kind: 'none' as const });
    // The short code stays while the link still goes to the same page.
    if (current?.link.code && this.links.same(link, current.link)) link.code = current.link.code;
    return {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.text !== undefined ? { text: input.text.trim() } : {}),
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      link,
    };
  }

  async create(input: CampaignInput) {
    await this.requireModule();
    const fields = await this.normalise(input);
    const draft = {
      name: fields.name || 'New campaign',
      text: fields.text ?? '',
      audience: fields.audience ?? { ordered: 'ordered' as const },
      link: fields.link,
    };
    const errors = await this.problems(draft, false);
    if (errors.length) throw AppError.validation(errors);
    const actor = RequestContext.actor();
    const made = await this.campaigns.create({
      ...draft,
      status: 'draft',
      nextRunAt: null,
      ...(actor.type === 'user' ? { createdBy: actor.id } : {}),
    });
    return this.get(made._id.toHexString());
  }

  private async require(id: string): Promise<CampaignDoc> {
    const c = Types.ObjectId.isValid(id) ? await this.campaigns.findById(id) : null;
    if (!c) throw AppError.notFound('campaign');
    return c;
  }

  /** Changes a draft, or a scheduled campaign before it starts. */
  async update(id: string, input: CampaignInput) {
    const c = await this.require(id);
    if (c.status !== 'draft' && c.status !== 'scheduled')
      throw AppError.conflict('campaign_started', 'A campaign cannot be changed once it started.');
    const fields = await this.normalise(input, c);
    const next = { text: fields.text ?? c.text, link: fields.link };
    const errors = await this.problems(next, c.status === 'scheduled');
    if (fields.name !== undefined && !fields.name)
      errors.push({ path: 'name', message: 'Give the campaign a name' });
    if (errors.length) throw AppError.validation(errors);
    const done = await this.campaigns.updateOne(
      { _id: c._id, status: { $in: ['draft', 'scheduled'] } },
      { $set: fields },
    );
    if (!done.matched)
      throw AppError.conflict('campaign_started', 'A campaign cannot be changed once it started.');
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const c = await this.require(id);
    if (c.status !== 'draft')
      throw AppError.conflict(
        'campaign_not_draft',
        'Only drafts can be deleted. Cancel a scheduled campaign first.',
      );
    await this.campaigns.deleteOne({ _id: c._id, status: 'draft' });
  }

  async duplicate(id: string) {
    const c = await this.require(id);
    const { code: _code, ...link } = c.link;
    void _code;
    const actor = RequestContext.actor();
    const made = await this.campaigns.create({
      name: `${c.name} (copy)`.slice(0, 80),
      text: c.text,
      audience: c.audience,
      link,
      status: 'draft',
      nextRunAt: null,
      ...(actor.type === 'user' ? { createdBy: actor.id } : {}),
    });
    return this.get(made._id.toHexString());
  }

  // ---------------------------------------------------------------- test send

  async test(id: string, rawTo: string) {
    const c = await this.require(id);
    if (c.tests >= MAX_CAMPAIGN_TESTS)
      throw AppError.conflict(
        'test_limit',
        `This campaign has had ${MAX_CAMPAIGN_TESTS} test texts already.`,
      );
    const errors = await this.problems(c, true);
    if (errors.length) throw AppError.validation(errors);
    const org = await this.orgs.get(this.orgId());
    const to = normalizePhone(rawTo, org.country);
    if (!to) throw AppError.validation([{ path: 'to', message: 'Invalid phone number' }]);
    const smsSettings = await this.sms.settings();
    if (smsSettings.mode === 'off')
      throw AppError.unprocessable('sms_off', 'Turn on SMS in Settings › SMS first.');
    const claimed = await this.campaigns.findOneAndUpdate(
      { _id: c._id, tests: c.tests },
      { $inc: { tests: 1 } },
    );
    if (!claimed) throw AppError.conflict('try_again', 'The campaign changed. Try again.');
    const link = await this.linkFor(claimed);
    const language = textLanguage(c.text);
    const samples = await this.samples(claimed.link, smsSettings);
    const text = composeMarketing(
      c.text,
      { ...samples[language], ...(link ? { link } : {}) },
      language,
      await this.sms.optOutUrl(to),
    );
    const result = await this.sms.enqueue(
      {
        to,
        text,
        purpose: 'test',
        key: `campaign:${c._id.toHexString()}:test:${claimed.tests}`,
        ref: { type: 'campaign_test', id: c._id.toHexString(), label: c.name },
      },
      { now: true },
    );
    if (!result.message) throw AppError.unprocessable('sms_off', 'SMS is off.');
    return this.sms.toDto(result.message);
  }

  /** The campaign's short link, made the first time it is needed. */
  private async linkFor(c: CampaignDoc): Promise<string | null> {
    if (c.link.kind === 'none') return null;
    const made = await this.links.ensure(
      c.link,
      { type: 'campaign', id: c._id.toHexString() },
      utmName(c.name),
    );
    if (!made) return null;
    if (made.code !== c.link.code)
      await this.campaigns.updateOne({ _id: c._id }, { $set: { 'link.code': made.code } });
    return made.url;
  }

  // ---------------------------------------------------------------- starting

  /** What sending to everyone would cost now, and whether the wallet has it. */
  private async estimate(c: CampaignDoc, recipients: number) {
    const smsSettings = await this.sms.settings();
    const route = await this.sms.resolveRoute(smsSettings);
    if ('failure' in route) return { route, estimate: null };
    const preview = await this.preview(c.text, c.link, smsSettings);
    return {
      route,
      estimate: {
        recipients,
        parts: preview.parts,
        pricePerPartMinor: route.pricePerPart,
        totalMinor: recipients * preview.parts * route.pricePerPart,
        currency: route.currency,
      },
    };
  }

  /** Checks a campaign can go: text, link, plan, SMS, audience, and wallet cash. */
  private async readiness(c: CampaignDoc, now: Date) {
    await this.requireModule();
    const errors = await this.problems(c, true);
    if (errors.length) throw AppError.validation(errors);
    if (c.link.kind !== 'none') await this.links.choose(this.linkInput(c.link));
    const { recipients } = await this.count(c.audience, now);
    if (!recipients)
      throw AppError.unprocessable('empty_audience', 'No customer matches who you chose.');
    const { route, estimate } = await this.estimate(c, recipients);
    if (!estimate) throw AppError.unprocessable('sms_off', (route as { message: string }).message);
    if (estimate.totalMinor > 0) {
      const cash = (await this.wallet.balance()).withdrawableMinor;
      if (cash < estimate.totalMinor)
        throw AppError.paymentRequired(
          'insufficient_balance',
          `This campaign needs about ${formatMoney(estimate.totalMinor, estimate.currency)} of wallet cash; you have ${formatMoney(cash, estimate.currency)}. Top up first.`,
        );
    }
    return estimate;
  }

  private linkInput(l: LinkChoice): LinkInput {
    return {
      kind: l.kind,
      ...(l.storeId ? { storeId: l.storeId.toHexString() } : {}),
      ...(l.targetId ? { targetId: l.targetId } : {}),
    };
  }

  /** Starts now, or at `at` (in the sending hours). */
  async start(id: string, opts: { at?: Date } = {}, now = new Date()) {
    const c = await this.require(id);
    if (c.status !== 'draft' && c.status !== 'scheduled')
      throw AppError.conflict('campaign_started', 'This campaign already started.');
    const org = await this.orgs.get(this.orgId());
    const actor = RequestContext.actor();
    if (opts.at) {
      const at = opts.at;
      if (
        at.getTime() < now.getTime() + MIN_SCHEDULE_MS ||
        at.getTime() > now.getTime() + MAX_SCHEDULE_MS
      )
        throw AppError.validation([
          { path: 'at', message: 'Choose a time from 5 minutes to 60 days from now' },
        ]);
      if (!inSendWindow(at, org.timezone))
        throw AppError.validation([
          {
            path: 'at',
            message: 'Campaigns go out between 9 AM and 9 PM. Choose a time in those hours.',
          },
        ]);
      await this.readiness(c, now);
      await this.campaigns.updateOne(
        { _id: c._id, status: { $in: ['draft', 'scheduled'] } },
        {
          $set: {
            status: 'scheduled',
            scheduledAt: at,
            nextRunAt: at,
            ...(actor.type === 'user' ? { startedBy: actor.id } : {}),
          },
        },
      );
      await this.audit.record({
        orgId: this.orgId(),
        action: 'campaign.scheduled',
        target: { type: 'campaign', id, label: c.name },
        metadata: { at: at.toISOString() },
      });
      return this.get(id);
    }
    if (!inSendWindow(now, org.timezone))
      throw AppError.unprocessable(
        'outside_hours',
        'Campaigns go out between 9 AM and 9 PM. Schedule it for a time in those hours.',
      );
    await this.launch(c, now, actor.type === 'user' ? actor.id : undefined);
    return this.get(id);
  }

  /**
   * Writes the audience down as recipients and hands the campaign to the sweep. Used by
   * "Send now" and by the sweep for scheduled campaigns. Throws when it cannot go.
   */
  private async launch(c: CampaignDoc, now: Date, by?: string): Promise<void> {
    const estimate = await this.readiness(c, now);
    const claimed = await this.campaigns.findOneAndUpdate(
      { _id: c._id, status: { $in: ['draft', 'scheduled'] } },
      {
        $set: {
          status: 'sending',
          startedAt: now,
          estimate,
          nextRunAt: new Date(now.getTime() + LEASE_MS),
          ...(by ? { startedBy: by } : {}),
        },
        $unset: { pause: 1, wait: 1 },
      },
    );
    if (!claimed) throw AppError.conflict('campaign_started', 'This campaign already started.');
    const written = await this.writeRecipients(claimed, now);
    await this.recount(c._id);
    await this.campaigns.updateOne({ _id: c._id }, { $set: { nextRunAt: now } });
    await this.audit.record({
      orgId: this.orgId(),
      action: 'campaign.started',
      target: { type: 'campaign', id: c._id.toHexString(), label: c.name },
      metadata: {
        recipients: written,
        estimateMinor: estimate.totalMinor,
        currency: estimate.currency,
      },
    });
  }

  /** The audience as it is now, without numbers that asked to stop. Safe to run twice. */
  private async writeRecipients(c: CampaignDoc, now: Date): Promise<number> {
    const orgId = new Types.ObjectId(this.orgId());
    const cursor = this.customers.aggregate<{
      _id: Types.ObjectId;
      phone: string;
      name: string;
      stop: unknown[];
    }>([
      { $match: audienceFilter(c.audience, now) },
      { $project: { phone: 1, name: 1 } },
      {
        $lookup: {
          from: OPT_OUT_COLLECTION,
          let: { phone: '$phone' },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $eq: ['$orgId', orgId] }, { $eq: ['$phone', '$$phone'] }] },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: 'stop',
        },
      },
    ]);
    const rows = await cursor;
    const docs = rows.map((r) => ({
      orgId,
      campaignId: c._id,
      customerId: r._id,
      phone: r.phone,
      name: r.name ?? '',
      ...(r.stop.length ? { status: 'skipped' as const, skip: 'opted_out' as const } : {}),
    }));
    for (let i = 0; i < docs.length; i += 1000) {
      try {
        await this.recipientModel.insertMany(docs.slice(i, i + 1000), { ordered: false });
      } catch (err) {
        // Written by an earlier, interrupted start: those rows stay as they are.
        if ((err as { code?: number }).code !== 11000 && !String(err).includes('E11000')) throw err;
      }
    }
    return docs.length;
  }

  /**
   * Sets the campaign's counts from its recipients, so a batch that ran twice (or stopped
   * half-way) never counts a number twice or leaves one out.
   */
  private async recount(campaignId: Types.ObjectId): Promise<void> {
    const rows = await this.recipients.aggregate<{
      _id: { status: string; skip?: string };
      n: number;
    }>([
      { $match: { campaignId } },
      { $group: { _id: { status: '$status', skip: '$skip' }, n: { $sum: 1 } } },
    ]);
    const sum = (f: (r: (typeof rows)[number]) => boolean) =>
      rows.filter(f).reduce((a, r) => a + r.n, 0);
    await this.campaigns.updateOne(
      { _id: campaignId },
      {
        $set: {
          'counts.recipients': sum(() => true),
          'counts.queued': sum((r) => r._id.status === 'queued'),
          'counts.optedOut': sum((r) => r._id.skip === 'opted_out'),
          'counts.unreachable': sum((r) => r._id.skip === 'unreachable'),
        },
      },
    );
  }

  // ---------------------------------------------------------------- pause, resume, cancel

  async pause(id: string) {
    const c = await this.require(id);
    const done = await this.campaigns.updateOne(
      { _id: c._id, status: 'sending' },
      {
        $set: { status: 'paused', pause: { reason: 'staff', at: new Date() }, nextRunAt: null },
        $unset: { wait: 1 },
      },
    );
    if (!done.matched) throw AppError.conflict('not_sending', 'This campaign is not sending.');
    await this.audit.record({
      orgId: this.orgId(),
      action: 'campaign.paused',
      target: { type: 'campaign', id, label: c.name },
    });
    return this.get(id);
  }

  async resume(id: string, now = new Date()) {
    const c = await this.require(id);
    if (c.status !== 'paused')
      throw AppError.conflict('not_paused', 'This campaign is not paused.');
    await this.requireModule();
    const smsSettings = await this.sms.settings();
    const route = await this.sms.resolveRoute(smsSettings);
    if ('failure' in route) throw AppError.unprocessable('sms_off', route.message);
    // Paused before it started (a scheduled start that could not go): it starts on the
    // next sweep, with every check again.
    await this.campaigns.updateOne(
      { _id: c._id, status: 'paused' },
      {
        $set: { status: c.startedAt ? 'sending' : 'scheduled', nextRunAt: now },
        $unset: { pause: 1 },
      },
    );
    await this.audit.record({
      orgId: this.orgId(),
      action: 'campaign.resumed',
      target: { type: 'campaign', id, label: c.name },
    });
    return this.get(id);
  }

  async cancel(id: string, now = new Date()) {
    const c = await this.require(id);
    const done = await this.campaigns.updateOne(
      { _id: c._id, status: { $in: ['scheduled', 'sending', 'paused'] } },
      { $set: { status: 'cancelled', cancelledAt: now, nextRunAt: null }, $unset: { wait: 1 } },
    );
    if (!done.matched)
      throw AppError.conflict(
        'not_cancellable',
        'Only scheduled or sending campaigns can be cancelled.',
      );
    await this.recipients.updateMany(
      { campaignId: c._id, status: 'pending' },
      { $set: { status: 'skipped', skip: 'cancelled' } },
    );
    await this.audit.record({
      orgId: this.orgId(),
      action: 'campaign.cancelled',
      target: { type: 'campaign', id, label: c.name },
    });
    return this.get(id);
  }

  // ---------------------------------------------------------------- the sweep

  /**
   * Starts scheduled campaigns and sends the next batch of those sending, in every business.
   * Crosses tenants: each campaign is handled inside its own business.
   */
  async sweep(now = new Date()): Promise<Record<string, number>> {
    const due = await this.campaignModel
      .find(
        { status: { $in: ['scheduled', 'sending'] }, nextRunAt: { $lte: now } },
        { _id: 1, orgId: 1 },
        { [CROSS_TENANT]: true },
      )
      .sort({ nextRunAt: 1 })
      .limit(SWEEP_LIMIT)
      .lean()
      .exec();
    const counts: Record<string, number> = {};
    for (const c of due) {
      let outcome: CampaignOutcome | 'error';
      try {
        outcome = await RequestContext.withTenant(
          c.orgId.toHexString(),
          () => this.run(c._id, now),
          { type: 'system', id: 'campaigns' },
        );
      } catch (err) {
        this.logger.error({ err, campaignId: c._id.toHexString() }, 'Campaign run failed');
        outcome = 'error';
        await RequestContext.withTenant(c.orgId.toHexString(), () =>
          this.campaigns.updateOne(
            { _id: c._id, status: { $in: ['scheduled', 'sending'] } },
            { $set: { nextRunAt: new Date(now.getTime() + RETRY_LATER_MS) } },
          ),
        ).catch(() => undefined);
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return counts;
  }

  /** One look at one campaign: start it, or send its next batch. */
  async run(id: Types.ObjectId, now = new Date()): Promise<CampaignOutcome> {
    // Claimed for a while, so a second worker (or a slow batch) does not run it twice.
    const c = await this.campaigns.findOneAndUpdate(
      { _id: id, status: { $in: ['scheduled', 'sending'] }, nextRunAt: { $lte: now } },
      { $set: { nextRunAt: new Date(now.getTime() + LEASE_MS) } },
    );
    if (!c) return 'raced';
    if (c.status === 'scheduled') return this.startScheduled(c, now);
    if (!c.counts.recipients && c.startedAt) {
      // An interrupted start: write the recipients again (rows already there stay).
      await this.writeRecipients(c, c.startedAt);
      await this.recount(c._id);
    }
    return this.batch((await this.campaigns.findById(c._id))!, now);
  }

  private async startScheduled(c: CampaignDoc, now: Date): Promise<CampaignOutcome> {
    const org = await this.orgs.get(this.orgId());
    if (!inSendWindow(now, org.timezone)) {
      await this.wait(c, 'night', nextSendTime(now, org.timezone));
      return 'night';
    }
    // Still held by the lease: a crash here leaves it for the next sweep after the lease.
    try {
      await this.launch(c, now, c.startedBy);
      return 'started';
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      const code = err.code;
      const reason: CampaignPause =
        code === 'insufficient_balance'
          ? 'wallet'
          : code === 'module_not_in_plan'
            ? 'not_in_plan'
            : code === 'sms_off'
              ? 'sms_off'
              : 'invalid';
      if (code === 'empty_audience') {
        await this.campaigns.updateOne(
          { _id: c._id, status: 'scheduled' },
          { $set: { status: 'sent', startedAt: now, finishedAt: now, nextRunAt: null } },
        );
        return 'empty';
      }
      await this.campaigns.updateOne(
        { _id: c._id, status: 'scheduled' },
        { $set: { status: 'paused', pause: { reason, at: now }, nextRunAt: null } },
      );
      if (reason === 'wallet') await this.tellOwnerWallet(c, err);
      return `paused:${reason}`;
    }
  }

  private async wait(c: CampaignDoc, reason: 'night' | 'daily_limit', until: Date) {
    await this.campaigns.updateOne(
      { _id: c._id },
      { $set: { wait: { reason, until }, nextRunAt: until } },
    );
  }

  private async pauseFor(c: CampaignDoc, reason: CampaignPause, now: Date) {
    await this.campaigns.updateOne(
      { _id: c._id, status: 'sending' },
      {
        $set: { status: 'paused', pause: { reason, at: now }, nextRunAt: null },
        $unset: { wait: 1 },
      },
    );
  }

  /** Sends up to one batch: checks SMS, the hour, today's limit and wallet cash first. */
  private async batch(c: CampaignDoc, now: Date): Promise<CampaignOutcome> {
    if (!(await this.entitlements.hasModule(this.orgId(), 'marketing'))) {
      await this.pauseFor(c, 'not_in_plan', now);
      return 'paused:not_in_plan';
    }
    const smsSettings = await this.sms.settings();
    const route = await this.sms.resolveRoute(smsSettings);
    if ('failure' in route) {
      await this.pauseFor(c, 'sms_off', now);
      return 'paused:sms_off';
    }
    const org = await this.orgs.get(this.orgId());
    if (!inSendWindow(now, org.timezone)) {
      await this.wait(c, 'night', nextSendTime(now, org.timezone));
      return 'night';
    }
    const left = this.sms.dailyLimit(smsSettings) - (await this.sms.sentToday());
    if (left <= 0) {
      await this.wait(c, 'daily_limit', tomorrowMorning(now, org.timezone));
      return 'daily_limit';
    }
    const pending = await this.recipients.find(
      { campaignId: c._id, status: 'pending' },
      { sort: { _id: 1 }, limit: Math.min(CAMPAIGN_BATCH, left) },
    );
    if (!pending.length) {
      await this.campaigns.updateOne(
        { _id: c._id, status: 'sending' },
        { $set: { status: 'sent', finishedAt: now, nextRunAt: null }, $unset: { wait: 1 } },
      );
      return 'finished';
    }

    const link = await this.linkFor(c);
    const shop = (await this.sms.shopValues(smsSettings)).shop;
    const language: SmsLanguage = textLanguage(c.text);
    const texts = await Promise.all(
      pending.map(async (r) => ({
        r,
        text: composeMarketing(
          c.text,
          { name: r.name, shop, ...(link ? { link } : {}) },
          language,
          await this.sms.optOutUrl(r.phone),
        ),
      })),
    );
    if (route.pricePerPart > 0) {
      const needed = texts.reduce(
        (a, t) => a + Math.max(1, smsLength(t.text).parts) * route.pricePerPart,
        0,
      );
      const cash = (await this.wallet.balance()).withdrawableMinor;
      if (cash < needed) {
        await this.pauseFor(c, 'wallet', now);
        await this.tellOwnerWallet(c, { needed, cash, currency: route.currency });
        return 'paused:wallet';
      }
    }

    for (const { r, text } of texts) {
      if (!canReach(route.provider.descriptor.reach, r.phone)) {
        await this.markRecipient(r, { status: 'skipped', skip: 'unreachable' });
        continue;
      }
      const result: SmsEnqueueResult = await this.sms.enqueue({
        to: r.phone,
        text,
        purpose: 'campaign',
        key: `campaign:${c._id.toHexString()}:${r.phone}`,
        ref: { type: 'campaign', id: c._id.toHexString(), label: c.name },
      });
      if (result.message === null) {
        if (result.skipped === 'off') {
          // SMS was switched off during the batch: the rest wait for it.
          await this.pauseFor(c, 'sms_off', now);
          break;
        }
        await this.markRecipient(r, { status: 'skipped', skip: 'opted_out' });
        continue;
      }
      await this.markRecipient(r, {
        status: 'queued',
        messageId: result.message._id.toHexString(),
        // A message made by an earlier run of this batch keeps its own time.
        queuedAt: result.created ? now : result.message.createdAt,
      });
    }
    await this.recount(c._id);
    await this.campaigns.updateOne(
      { _id: c._id, status: 'sending' },
      { $set: { nextRunAt: new Date(now.getTime() + BATCH_EVERY_MS) }, $unset: { wait: 1 } },
    );
    return 'batch';
  }

  private async markRecipient(
    r: CampaignRecipientDoc,
    set: Partial<Pick<CampaignRecipient, 'status' | 'skip' | 'messageId' | 'queuedAt'>>,
  ) {
    await this.recipients.updateOne({ _id: r._id, status: 'pending' }, { $set: set });
  }

  /** Emails the owner that the campaign stopped for wallet cash. A mail failure is logged. */
  private async tellOwnerWallet(c: CampaignDoc, info: unknown) {
    try {
      const org = await this.orgs.get(this.orgId());
      const [owner] = await this.users.findByIds([org.ownerUserId]);
      if (!owner) return;
      const detail = info as { needed?: number; cash?: number; currency?: string };
      const currency = detail.currency ?? org.currency;
      const cash = detail.cash ?? (await this.wallet.balance()).withdrawableMinor;
      const needed = detail.needed ?? c.estimate?.totalMinor ?? 0;
      const web = this.config.get('WEB_APP_URL').replace(/\/$/, '');
      await this.mail.send({
        to: owner.email,
        category: 'marketing',
        ...mailTemplates.campaignPaused(owner.locale, {
          businessName: org.name,
          campaign: c.name,
          needed: formatMoney(needed, currency),
          have: formatMoney(cash, currency),
          url: `${web}/app/${org._id.toHexString()}/marketing/campaigns/${c._id.toHexString()}`,
        }),
      });
    } catch (err) {
      this.logger.error({ err, campaignId: c._id.toHexString() }, 'Could not email the owner');
    }
  }

  // ---------------------------------------------------------------- orders after

  /**
   * Counts an order for the latest campaign or automation text the number got in the 7 days
   * before it (once per text, and only when the text was not refused).
   */
  async orderCreated(order: OrderDoc): Promise<'campaign' | 'automation' | null> {
    const phone = order.customer.phone ?? order.shippingAddress.phone;
    if (!phone) return null;
    const since = new Date(order.placedAt.getTime() - ORDER_WINDOW_MS);
    const [recipient, send] = await Promise.all([
      this.recipients.findOne(
        {
          phone,
          status: 'queued',
          queuedAt: { $gte: since, $lte: order.placedAt },
          order: { $exists: false },
        },
        undefined,
        { sort: { queuedAt: -1 } },
      ),
      this.automationSends.findOne(
        {
          phone,
          status: 'sent',
          sentAt: { $gte: since, $lte: order.placedAt },
          order: { $exists: false },
        },
        undefined,
        { sort: { sentAt: -1 } },
      ),
    ]);
    const marked = {
      id: order._id.toHexString(),
      number: order.number,
      totalMinor: order.totalMinor,
      at: order.placedAt,
    };
    const useCampaign =
      recipient && (!send || recipient.queuedAt!.getTime() >= send.sentAt!.getTime());
    const candidate = useCampaign ? recipient : send;
    if (!candidate?.messageId) return null;
    const [message] = await this.sms.findMessages([candidate.messageId]);
    if (!message || !COUNTED_STATUSES.has(message.status)) return null;
    if (useCampaign) {
      const done = await this.recipients.updateOne(
        { _id: recipient._id, order: { $exists: false } },
        { $set: { order: marked } },
      );
      if (!done.modified) return null;
      await this.campaigns.updateOne(
        { _id: recipient.campaignId },
        { $inc: { 'orders.count': 1, 'orders.revenueMinor': order.totalMinor } },
      );
      return 'campaign';
    }
    const done = await this.automationSends.updateOne(
      { _id: send!._id, order: { $exists: false } },
      { $set: { order: marked } },
    );
    return done.modified ? 'automation' : null;
  }

  // ---------------------------------------------------------------- reading

  async list(q: { status?: CampaignStatus; limit: number; cursor?: string }) {
    const filter: QueryFilter<Campaign> = q.status ? { status: q.status } : {};
    const page = await this.campaigns.paginate(filter, {
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    return { ...page, items: page.items.map((c) => this.summaryDto(c)) } satisfies Page<unknown>;
  }

  private summaryDto(c: CampaignDoc) {
    return {
      id: c._id.toHexString(),
      name: c.name,
      status: c.status,
      text: c.text,
      link: { kind: c.link.kind, label: c.link.label ?? null },
      scheduledAt: c.scheduledAt?.toISOString() ?? null,
      startedAt: c.startedAt?.toISOString() ?? null,
      finishedAt: c.finishedAt?.toISOString() ?? null,
      pause: c.pause ? { reason: c.pause.reason, at: c.pause.at.toISOString() } : null,
      wait: c.wait ? { reason: c.wait.reason, until: c.wait.until.toISOString() } : null,
      counts: c.counts,
      orders: c.orders,
      estimate: c.estimate ?? null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  async get(id: string) {
    const c = await this.require(id);
    const ref = { type: 'campaign', id: c._id.toHexString() };
    const [messages, clicks, preview, stopped, linkUrl] = await Promise.all([
      this.sms.statsFor(ref),
      this.links.clicks(c.link.code),
      this.preview(c.text, c.link),
      c.startedAt ? this.stoppedAfter(c) : Promise.resolve(0),
      c.link.kind === 'none' ? Promise.resolve(null) : this.links.previewUrl(c.link),
    ]);
    const handled = c.counts.queued + c.counts.optedOut + c.counts.unreachable;
    return {
      ...this.summaryDto(c),
      audience: c.audience,
      link: {
        kind: c.link.kind,
        label: c.link.label ?? null,
        storeId: c.link.storeId?.toHexString() ?? null,
        targetId: c.link.targetId ?? null,
        path: c.link.path ?? null,
        url: c.link.code ? linkUrl : null,
        ...clicks,
      },
      preview,
      cancelledAt: c.cancelledAt?.toISOString() ?? null,
      progress: c.counts.recipients ? Math.min(1, handled / c.counts.recipients) : 0,
      messages,
      stopped,
      testsLeft: Math.max(0, MAX_CAMPAIGN_TESTS - c.tests),
    };
  }

  /** Recipients who pressed stop after the campaign started (their link is per number). */
  private async stoppedAfter(c: CampaignDoc): Promise<number> {
    const [row] = await this.recipients.aggregate<{ n: number }>([
      { $match: { campaignId: c._id, status: 'queued' } },
      {
        $lookup: {
          from: OPT_OUT_COLLECTION,
          let: { phone: '$phone' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$orgId', new Types.ObjectId(this.orgId())] },
                    { $eq: ['$phone', '$$phone'] },
                    { $gte: ['$createdAt', c.startedAt] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: 'stop',
        },
      },
      { $match: { 'stop.0': { $exists: true } } },
      { $count: 'n' },
    ]);
    return row?.n ?? 0;
  }

  async listRecipients(
    id: string,
    q: { status?: 'queued' | 'skipped' | 'pending' | 'ordered'; limit: number; cursor?: string },
  ) {
    const c = await this.require(id);
    const filter: QueryFilter<CampaignRecipient> = { campaignId: c._id };
    if (q.status === 'ordered') filter.order = { $exists: true };
    else if (q.status) filter.status = q.status;
    const page = await this.recipients.paginate(filter, {
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
          customerId: r.customerId.toHexString(),
          name: r.name,
          phone: r.phone,
          status: r.status,
          skip: r.skip ?? null,
          queuedAt: r.queuedAt?.toISOString() ?? null,
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
        };
      }),
    };
  }

  /** Problems with a text for the editor, without saving (field errors as the API gives). */
  async check(input: { text: string; link?: LinkInput }): Promise<{
    errors: FieldError[];
    preview: Awaited<ReturnType<CampaignsService['preview']>>;
  }> {
    const link = await this.links.choose(input.link);
    return {
      errors: await this.problems({ text: input.text, link }, true),
      preview: await this.preview(input.text, link),
    };
  }
}
