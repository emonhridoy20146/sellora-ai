import { randomInt } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Types, type Model, type QueryFilter } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import type { Page } from '../../common/pagination/cursor.js';
import { startOfDayInZone } from '../../common/time/zoned.js';
import { nationalDigits } from '../../common/validation/schemas.js';
import { AppConfig } from '../../config/app-config.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { WalletService } from '../billing/wallet.service.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { ownCredentialsAad } from './gateways.js';
import { SmsProviders } from './providers/sms-providers.js';
import {
  SmsLinkRepository,
  SmsMessageRepository,
  SmsOptOutRepository,
  SmsSettingsRepository,
  type SmsMessageDoc,
  type SmsSettingsDoc,
} from './repositories.js';
import {
  SMS_STATUSES,
  type SmsFailure,
  type SmsLink,
  type SmsMessage,
  type SmsRoute,
  type SmsStatus,
} from './schemas.js';
import { MAX_SMS_PARTS, plainSmsText, smsLength } from './segments.js';
import { SmsPlatformService } from './sms-platform.service.js';
import {
  SmsError,
  canReach,
  type SmsContext,
  type SmsProvider,
  type SmsProviderKey,
} from './sms.types.js';
import { MARKETING_PURPOSES, defaultOrderTemplates, type SmsPurpose } from './templates.js';

export const SMS_SEND_JOB = 'send';
export const SMS_SWEEP_JOB = 'sweep';
export interface SmsJob {
  orgId: string;
  messageId: string;
}

/** A message stuck in "sending" this long was interrupted (a crash); it is not sent again. */
const STUCK_AFTER_MS = 10 * 60_000;

/** How a message would leave right now. */
export interface SmsRouteInfo {
  route: SmsRoute;
  providerKey: SmsProviderKey;
  provider: SmsProvider;
  senderId: string;
  /** Sent from the business's approved sender name (priced as such on Sellora SMS). */
  senderName: boolean;
  /** What one part costs the business (0 on its own gateway). */
  pricePerPart: number;
  costPerPart: number;
  currency: string;
  context(statusCallbackUrl?: string): SmsContext<unknown>;
}

export interface SmsRouteProblem {
  route: SmsRoute;
  failure: SmsFailure;
  message: string;
}

export interface SmsSendInput {
  /** E.164. */
  to: string;
  text: string;
  purpose: SmsPurpose;
  /** What this message is, unique per business: a second message with the key is not made. */
  key: string;
  ref?: { type: string; id: string; label?: string };
}

export type SmsEnqueueResult =
  { message: SmsMessageDoc; created: boolean } | { message: null; skipped: 'off' | 'opted_out' };

/** "017•••••678": enough for staff to recognise a number in lists and wallet history. */
export function maskPhone(e164: string): string {
  const national = nationalDigits(e164) ?? e164.replace(/\D/g, '');
  if (national.length < 7) return national;
  return `${national.slice(0, 3)}${'•'.repeat(national.length - 6)}${national.slice(-3)}`;
}

const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function linkCode(): string {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/**
 * Sends SMS for one business (ADR 0017): writes each message down once, holds its price in
 * the wallet, hands it to the worker, and settles the price when the provider answers.
 * Must run inside a tenant scope, except where a method says it crosses tenants.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly settingsRepo: SmsSettingsRepository,
    private readonly messages: SmsMessageRepository,
    private readonly optOuts: SmsOptOutRepository,
    private readonly links: SmsLinkRepository,
    @InjectModel('SmsMessage') private readonly messageModel: Model<SmsMessage>,
    @InjectModel('SmsLink') private readonly linkModel: Model<SmsLink>,
    private readonly platform: SmsPlatformService,
    private readonly providers: SmsProviders,
    private readonly encryption: EncryptionService,
    private readonly wallet: WalletService,
    private readonly orgs: OrgsService,
    private readonly config: AppConfig,
    @InjectQueue(QUEUES.sms) private readonly queue: Queue<SmsJob>,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  // ---------------------------------------------------------------- settings and route

  /** The business's SMS settings, made with defaults on first use (SMS off). */
  async settings(): Promise<SmsSettingsDoc> {
    const found = await this.settingsRepo.findOne({});
    if (found) return found;
    const org = await this.orgs.get(this.orgId());
    try {
      return await this.settingsRepo.create({
        mode: 'off',
        language: org.locale,
        shopName: '',
        contactPhone: '',
        useSenderName: false,
        orderTemplates: defaultOrderTemplates(org.locale),
        dailyLimit: null,
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      return (await this.settingsRepo.findOne({}))!;
    }
  }

  /** {shop} and {phone} in this business's messages. */
  async shopValues(s: SmsSettingsDoc): Promise<{ shop: string; phone: string }> {
    const org = await this.orgs.get(this.orgId());
    const saved = org.contact?.phone
      ? (nationalDigits(org.contact.phone) ?? org.contact.phone)
      : '';
    return { shop: s.shopName || org.name, phone: s.contactPhone || saved };
  }

  /** The business's own provider context (route "own"). */
  ownContext(s: SmsSettingsDoc, statusCallbackUrl?: string): SmsContext<unknown> {
    const own = s.own!;
    const provider = this.providers.get(own.provider);
    return {
      credentials: provider.credentials.parse(
        JSON.parse(this.encryption.decrypt(own.credentialsEnc, ownCredentialsAad(this.orgId()))),
      ),
      ...(own.senderId ? { senderId: own.senderId } : {}),
      ...(statusCallbackUrl ? { statusCallbackUrl } : {}),
    };
  }

  /** How a message would leave now, or why it cannot. */
  async resolveRoute(s: SmsSettingsDoc): Promise<SmsRouteInfo | SmsRouteProblem> {
    const org = await this.orgs.get(this.orgId());
    if (s.mode === 'own' || (s.mode === 'off' && s.own)) {
      if (s.mode === 'off')
        return { route: 'own', failure: 'not_configured', message: 'SMS is turned off.' };
      if (!s.own)
        return {
          route: 'own',
          failure: 'not_configured',
          message: 'Connect your SMS provider in Settings › SMS.',
        };
      const own = s.own;
      const provider = this.providers.get(own.provider);
      return {
        route: 'own',
        providerKey: own.provider,
        provider,
        senderId: own.senderId,
        senderName: false,
        pricePerPart: 0,
        costPerPart: 0,
        currency: org.currency,
        context: (url) => this.ownContext(s, url),
      };
    }
    if (s.mode === 'off')
      return { route: 'sellora', failure: 'not_configured', message: 'SMS is turned off.' };
    const p = await this.platform.get();
    if (!this.platform.ready(p))
      return {
        route: 'sellora',
        failure: 'not_configured',
        message:
          'Sellora SMS is not available right now. Try again later or use your own provider.',
      };
    const currency = (await this.wallet.get()).currency;
    const senderName = s.useSenderName && s.senderName?.status === 'approved';
    const price = this.platform.priceFor(p.prices, currency, senderName);
    if (price === null)
      return {
        route: 'sellora',
        failure: 'not_configured',
        message: `Sellora SMS has no price in ${currency} yet.`,
      };
    return {
      route: 'sellora',
      providerKey: p.provider,
      provider: this.platform.provider(p),
      senderId: senderName ? s.senderName!.name : p.senderId,
      senderName,
      pricePerPart: price,
      costPerPart: this.platform.priceFor(p.costs, currency, senderName) ?? 0,
      currency,
      context: (url) => this.platform.context(p, senderName ? s.senderName!.name : p.senderId, url),
    };
  }

  private callbackUrl(provider: SmsProvider, messageId: string): string | undefined {
    if (!provider.descriptor.deliveryReports) return undefined;
    const base = this.config.get('API_PUBLIC_URL').replace(/\/$/, '');
    return `${base}/v1/public/sms/callbacks/${provider.descriptor.key}/${messageId}`;
  }

  /** Messages a day this business may send. */
  dailyLimit(s: SmsSettingsDoc): number {
    return s.dailyLimit ?? this.config.get('SMS_DAILY_LIMIT');
  }

  async sentToday(): Promise<number> {
    const org = await this.orgs.get(this.orgId());
    return this.messages.count({
      createdAt: { $gte: startOfDayInZone(new Date(), org.timezone) },
      failure: { $nin: ['daily_limit', 'not_configured'] },
    });
  }

  // ---------------------------------------------------------------- sending

  /**
   * Writes the message down and hands it to the worker. Nothing is made when SMS is off, or
   * for a marketing message to a number that opted out. A message whose key already exists
   * is returned as it is. Problems known now (no provider, a number the provider cannot
   * reach, the daily limit) are recorded as a failed message, so staff can see why.
   * `now` sends in this request instead of the worker (a test message staff wait for).
   */
  async enqueue(input: SmsSendInput, opts: { now?: boolean } = {}): Promise<SmsEnqueueResult> {
    const s = await this.settings();
    if (s.mode === 'off') return { message: null, skipped: 'off' };
    const marketing = MARKETING_PURPOSES.has(input.purpose);
    if (marketing && (await this.isOptedOut(input.to)))
      return { message: null, skipped: 'opted_out' };
    const existing = await this.messages.findOne({ key: input.key });
    if (existing) return { message: existing, created: false };

    const route = await this.resolveRoute(s);
    const text = plainSmsText(input.text).trim();
    const length = smsLength(text);
    let problem: { failure: SmsFailure; error: string } | null = null;
    if ('failure' in route) problem = { failure: route.failure, error: route.message };
    else if (!canReach(route.provider.descriptor.reach, input.to))
      problem = {
        failure: 'unreachable_number',
        error:
          route.provider.descriptor.reach === 'bd_mobile'
            ? `${route.provider.descriptor.name} only sends to Bangladeshi mobile numbers.`
            : 'This is not a number SMS can reach.',
      };
    else if (length.parts === 0) problem = { failure: 'rejected', error: 'The message is empty.' };
    else if (length.parts > MAX_SMS_PARTS)
      problem = {
        failure: 'rejected',
        error: `The message needs ${length.parts} parts; the most is ${MAX_SMS_PARTS}.`,
      };
    else if ((await this.sentToday()) >= this.dailyLimit(s))
      problem = {
        failure: 'daily_limit',
        error: `This business has sent its ${this.dailyLimit(s)} messages for today. Ask Sellora support for a higher limit.`,
      };

    const ok = 'failure' in route ? null : route;
    const now = new Date();
    let message: SmsMessageDoc;
    try {
      message = await this.messages.create({
        key: input.key,
        to: input.to,
        body: text || '(empty)',
        purpose: input.purpose,
        marketing,
        ...(input.ref ? { ref: input.ref } : {}),
        route: route.route,
        ...(ok ? { provider: ok.providerKey } : {}),
        senderId: ok?.senderId ?? '',
        encoding: length.encoding,
        parts: Math.max(1, length.parts),
        priceMinor: ok ? ok.pricePerPart * Math.max(1, length.parts) : 0,
        costMinor: ok ? ok.costPerPart * Math.max(1, length.parts) : 0,
        currency: ok?.currency ?? (await this.orgs.get(this.orgId())).currency,
        held: false,
        status: problem ? 'failed' : 'queued',
        ...(problem ? { failure: problem.failure, error: problem.error, failedAt: now } : {}),
        queuedAt: now,
        actor: { type: RequestContext.actor().type, id: RequestContext.actor().id },
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      return { message: (await this.messages.findOne({ key: input.key }))!, created: false };
    }
    if (problem) return { message, created: true };
    if (opts.now) {
      const sent = await this.send(message._id.toHexString(), { final: true });
      return { message: sent ?? (await this.messages.findById(message._id))!, created: true };
    }
    await this.schedule(message);
    return { message, created: true };
  }

  private async schedule(message: SmsMessageDoc): Promise<void> {
    const id = message._id.toHexString();
    await this.queue.add(
      SMS_SEND_JOB,
      { orgId: this.orgId(), messageId: id },
      // One send per message, ever; BullMQ retries it while the provider is unreachable.
      { jobId: `sms-${id}`, attempts: 5, backoff: { type: 'exponential', delay: 5_000 } },
    );
  }

  private async fail(
    id: Types.ObjectId,
    failure: SmsFailure,
    error: string,
    from: SmsStatus = 'sending',
  ): Promise<SmsMessageDoc | null> {
    return this.messages.findOneAndUpdate(
      { _id: id, status: from },
      { $set: { status: 'failed', failure, error, failedAt: new Date(), held: false } },
    );
  }

  /**
   * Sends one queued message (the worker). Claims it first, so two workers never send the
   * same message; holds its price; calls the provider; then charges the wallet or releases
   * the hold. `final` is the last attempt: an unreachable provider then fails the message.
   */
  async send(messageId: string, opts: { final: boolean }): Promise<SmsMessageDoc | null> {
    const claimed = await this.messages.findOneAndUpdate(
      { _id: new Types.ObjectId(messageId), status: 'queued' },
      { $set: { status: 'sending' } },
    );
    if (!claimed) return null;
    const s = await this.settings();
    const route = await this.resolveRoute(s);
    if ('failure' in route) return this.fail(claimed._id, route.failure, route.message);
    if (!canReach(route.provider.descriptor.reach, claimed.to))
      return this.fail(
        claimed._id,
        'unreachable_number',
        `${route.provider.descriptor.name} only sends to Bangladeshi mobile numbers.`,
      );

    // The route may have changed since the message was made (another provider, a new price).
    const price = route.pricePerPart * claimed.parts;
    const cost = route.costPerPart * claimed.parts;
    if (price > 0) {
      try {
        await this.wallet.hold(price, { excludeBonus: true });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        return this.fail(
          claimed._id,
          'insufficient_balance',
          err.code === 'wallet_frozen'
            ? 'The wallet is frozen, so SMS cannot be paid for.'
            : 'The wallet does not have enough cash for this SMS. Top up to keep sending messages.',
        );
      }
    }
    await this.messages.updateOne(
      { _id: claimed._id },
      {
        $set: {
          route: route.route,
          provider: route.providerKey,
          senderId: route.senderId,
          priceMinor: price,
          costMinor: cost,
          currency: route.currency,
          held: price > 0,
        },
      },
    );

    const id = claimed._id.toHexString();
    try {
      const result = await route.provider.send(
        route.context(this.callbackUrl(route.provider, id)),
        {
          to: claimed.to,
          text: claimed.body,
          reference: id,
          unicode: claimed.encoding === 'unicode',
        },
      );
      const sent = await this.messages.findOneAndUpdate(
        { _id: claimed._id, status: 'sending' },
        {
          $set: {
            status: 'sent',
            sentAt: new Date(),
            held: false,
            providerStatus: result.providerStatus,
            ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
          },
        },
      );
      if (price > 0) await this.charge(claimed, price);
      if (route.route === 'own' && s.own?.lastError)
        await this.settingsRepo.updateOne(
          {},
          { $unset: { 'own.lastError': 1, 'own.lastErrorAt': 1 } },
        );
      return sent;
    } catch (err) {
      if (price > 0) await this.wallet.release(price);
      const e =
        err instanceof SmsError
          ? err
          : new SmsError('unavailable', 'Sending failed unexpectedly. It will be tried again.');
      if (!(err instanceof SmsError)) this.logger.error({ err, messageId: id }, 'SMS send crashed');
      if ((e.kind === 'unavailable' || e.kind === 'busy') && !opts.final) {
        await this.messages.updateOne(
          { _id: claimed._id, status: 'sending' },
          { $set: { status: 'queued', held: false, error: e.message } },
        );
        throw e;
      }
      if (e.kind === 'uncertain') {
        return this.messages.findOneAndUpdate(
          { _id: claimed._id, status: 'sending' },
          { $set: { status: 'unknown', failure: 'uncertain', error: e.message, held: false } },
        );
      }
      if (route.route === 'own' && (e.kind === 'auth' || e.kind === 'balance'))
        await this.settingsRepo.updateOne(
          {},
          { $set: { 'own.lastError': e.message, 'own.lastErrorAt': new Date() } },
        );
      return this.fail(claimed._id, e.kind, e.message);
    }
  }

  /** Turns the hold into an sms_usage debit. A failure here never unsends the message. */
  private async charge(m: SmsMessageDoc, price: number): Promise<void> {
    const id = m._id.toHexString();
    try {
      await this.wallet.debit({
        type: 'sms_usage',
        amountMinor: price,
        consumeHeldMinor: price,
        idempotencyKey: `sms:${id}`,
        description: `SMS to ${maskPhone(m.to)} · ${m.parts} part${m.parts === 1 ? '' : 's'}`,
        reference: { type: 'sms_message', id },
        metadata: { purpose: m.purpose, parts: m.parts },
        allowFrozen: true,
      });
    } catch (err) {
      this.logger.error({ err, messageId: id }, 'Could not charge an SMS that was sent');
      await this.wallet.release(price).catch(() => undefined);
    }
  }

  /**
   * Messages left in "sending" by a crash: the provider may have sent them, so they become
   * "unknown" (never sent again, never charged) and their hold is released. Crosses tenants.
   */
  async sweepStuck(now = new Date()): Promise<number> {
    const stuck = await this.messageModel
      .find(
        { status: 'sending', updatedAt: { $lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
        { _id: 1, orgId: 1, held: 1, priceMinor: 1 },
        { [CROSS_TENANT]: true },
      )
      .limit(500)
      .lean()
      .exec();
    let swept = 0;
    for (const m of stuck) {
      await RequestContext.withTenant(m.orgId.toHexString(), async () => {
        const done = await this.messages.findOneAndUpdate(
          { _id: m._id, status: 'sending' },
          {
            $set: {
              status: 'unknown',
              failure: 'uncertain',
              error: 'Sending was interrupted. The message may or may not have been sent.',
              held: false,
            },
          },
        );
        if (done && m.held && m.priceMinor > 0) await this.wallet.release(m.priceMinor);
        if (done) swept += 1;
      });
    }
    return swept;
  }

  /**
   * A provider's delivery report for one message (Twilio). The message id comes from the
   * callback address; the report must carry the provider's signature for the account the
   * message went out on. Crosses tenants (callbacks have no session).
   */
  async applyCallback(
    providerKey: SmsProviderKey,
    messageId: string,
    call: { url: string; params: Record<string, string>; headers: Record<string, string> },
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(messageId)) return false;
    const m = await this.messageModel
      .findOne({ _id: new Types.ObjectId(messageId), provider: providerKey }, null, {
        [CROSS_TENANT]: true,
      })
      .lean()
      .exec();
    if (!m) return false;
    const provider = this.providers.get(providerKey);
    if (!provider.readCallback) return false;
    return RequestContext.withTenant(m.orgId.toHexString(), async () => {
      let credentials: unknown;
      if (m.route === 'own') {
        const s = await this.settings();
        if (!s.own || s.own.provider !== providerKey) return false;
        credentials = this.ownContext(s).credentials;
      } else {
        const p = await this.platform.get();
        if (p.provider !== providerKey) return false;
        credentials = this.platform.credentials(p);
      }
      const report = provider.readCallback!(credentials, call);
      if (!report || (m.providerMessageId && report.providerMessageId !== m.providerMessageId))
        return false;
      if (report.status === 'delivered')
        await this.messages.updateOne(
          { _id: m._id, status: { $in: ['sent', 'unknown'] } },
          {
            $set: { status: 'delivered', deliveredAt: new Date() },
            $unset: { failure: 1, error: 1 },
          },
        );
      else if (report.status === 'failed')
        await this.messages.updateOne(
          { _id: m._id, status: { $in: ['sent', 'unknown'] } },
          {
            $set: {
              status: 'failed',
              failure: 'rejected',
              error: report.error ?? 'Not delivered.',
              failedAt: new Date(),
            },
          },
        );
      return true;
    });
  }

  // ---------------------------------------------------------------- reading

  async list(q: {
    limit: number;
    cursor?: string;
    status?: SmsStatus;
    purpose?: SmsPurpose;
    phone?: string;
    refType?: string;
    refId?: string;
  }): Promise<Page<SmsMessageDoc>> {
    const filter: QueryFilter<SmsMessage> = {};
    if (q.status) filter.status = q.status;
    if (q.purpose) filter.purpose = q.purpose;
    if (q.phone) filter.to = q.phone;
    if (q.refType && q.refId) {
      filter['ref.type'] = q.refType;
      filter['ref.id'] = q.refId;
    }
    return this.messages.paginate(filter, {
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
  }

  /** This business's messages with these ids (unknown or malformed ids are left out). */
  async findMessages(ids: string[]): Promise<SmsMessageDoc[]> {
    const valid = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id));
    if (!valid.length) return [];
    return this.messages.find({ _id: { $in: valid.map((id) => new Types.ObjectId(id)) } });
  }

  /**
   * Messages for one purpose sent since `since` (any route), and what the Sellora SMS among
   * them cost the business.
   */
  async spentOn(purpose: SmsPurpose, since: Date): Promise<{ count: number; spentMinor: number }> {
    const [row] = await this.messages.aggregate<{ count: number; spentMinor: number }>([
      {
        $match: { purpose, createdAt: { $gte: since }, status: { $in: ['sent', 'delivered'] } },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          spentMinor: { $sum: { $cond: [{ $eq: ['$route', 'sellora'] }, '$priceMinor', 0] } },
        },
      },
    ]);
    return { count: row?.count ?? 0, spentMinor: row?.spentMinor ?? 0 };
  }

  /**
   * Messages made for one thing (a campaign, an automation) by status, and what the Sellora
   * SMS among them cost: only messages the provider accepted are charged.
   */
  async statsFor(
    ref: { type: string; id: string },
    since?: Date,
  ): Promise<{ byStatus: Record<SmsStatus, number>; spentMinor: number }> {
    const rows = await this.messages.aggregate<{ _id: SmsStatus; count: number; spent: number }>([
      {
        $match: {
          'ref.type': ref.type,
          'ref.id': ref.id,
          ...(since ? { createdAt: { $gte: since } } : {}),
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          spent: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$route', 'sellora'] },
                    { $in: ['$status', ['sent', 'delivered']] },
                  ],
                },
                '$priceMinor',
                0,
              ],
            },
          },
        },
      },
    ]);
    const byStatus = Object.fromEntries(SMS_STATUSES.map((st) => [st, 0])) as Record<
      SmsStatus,
      number
    >;
    let spentMinor = 0;
    for (const r of rows) {
      byStatus[r._id] = r.count;
      spentMinor += r.spent;
    }
    return { byStatus, spentMinor };
  }

  toDto(m: SmsMessageDoc) {
    return {
      id: m._id.toHexString(),
      to: m.to,
      body: m.body,
      purpose: m.purpose,
      marketing: m.marketing,
      ref: m.ref ?? null,
      route: m.route,
      provider: m.provider ?? null,
      providerName: m.provider ? this.providers.get(m.provider).descriptor.name : null,
      senderId: m.senderId,
      encoding: m.encoding,
      parts: m.parts,
      priceMinor: m.priceMinor,
      currency: m.currency,
      status: m.status,
      failure: m.failure ?? null,
      error: m.error ?? null,
      createdAt: m.createdAt.toISOString(),
      sentAt: m.sentAt?.toISOString() ?? null,
      deliveredAt: m.deliveredAt?.toISOString() ?? null,
    };
  }

  /** The last 30 days at a glance: messages by status, parts, and what Sellora SMS cost. */
  async summary(now = new Date()) {
    const since = new Date(now.getTime() - 30 * 24 * 3600_000);
    const rows = await this.messages.aggregate<{
      _id: SmsStatus;
      count: number;
      parts: number;
      spentMinor: number;
    }>([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          parts: { $sum: '$parts' },
          spentMinor: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$route', 'sellora'] },
                    { $in: ['$status', ['sent', 'delivered']] },
                  ],
                },
                '$priceMinor',
                0,
              ],
            },
          },
        },
      },
    ]);
    const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.count])) as Partial<
      Record<SmsStatus, number>
    >;
    const s = await this.settings();
    return {
      days: 30,
      total: rows.reduce((a, r) => a + r.count, 0),
      sent: (byStatus.sent ?? 0) + (byStatus.delivered ?? 0),
      delivered: byStatus.delivered ?? 0,
      failed: byStatus.failed ?? 0,
      waiting: (byStatus.queued ?? 0) + (byStatus.sending ?? 0),
      unknown: byStatus.unknown ?? 0,
      parts: rows
        .filter((r) => r._id === 'sent' || r._id === 'delivered')
        .reduce((a, r) => a + r.parts, 0),
      spentMinor: rows.reduce((a, r) => a + r.spentMinor, 0),
      today: await this.sentToday(),
      dailyLimit: this.dailyLimit(s),
    };
  }

  // ---------------------------------------------------------------- opt-outs

  async isOptedOut(phone: string): Promise<boolean> {
    return this.optOuts.exists({ phone });
  }

  /** The short opt-out link for a number (`<web app>/u/<code>`), made on first use. */
  async optOutUrl(phone: string): Promise<string> {
    const web = this.config.get('WEB_APP_URL').replace(/\/$/, '');
    const found = await this.links.findOne({ phone });
    if (found) return `${web}/u/${found.code}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const made = await this.links.create({ code: linkCode(), phone });
        return `${web}/u/${made.code}`;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        // The same number at the same moment, or a code already taken: look again.
        const again = await this.links.findOne({ phone });
        if (again) return `${web}/u/${again.code}`;
      }
    }
    throw new Error('Could not make an opt-out link');
  }

  async stop(phone: string, source: 'link' | 'staff'): Promise<void> {
    const actor = RequestContext.actor();
    try {
      await this.optOuts.create({
        phone,
        source,
        ...(actor.type === 'user' ? { by: actor.id } : {}),
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
  }

  async allow(phone: string): Promise<void> {
    await this.optOuts.deleteOne({ phone });
  }

  async listOptOuts(q: { limit: number; cursor?: string }) {
    return this.optOuts.paginate({}, { limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
  }

  /** What the public opt-out page shows for a code. Crosses tenants. */
  async publicLink(
    code: string,
  ): Promise<{ shop: string; phone: string; stopped: boolean } | null> {
    const link = await this.findLink(code);
    if (!link) return null;
    return RequestContext.withTenant(link.orgId.toHexString(), async () => {
      const [org, s] = await Promise.all([this.orgs.get(this.orgId()), this.settings()]);
      return {
        shop: s.shopName || org.name,
        phone: maskPhone(link.phone),
        stopped: await this.isOptedOut(link.phone),
      };
    });
  }

  /** The shopper pressed "Stop messages" on the opt-out page. Crosses tenants. */
  async publicStop(code: string): Promise<boolean> {
    const link = await this.findLink(code);
    if (!link) return false;
    await RequestContext.withTenant(link.orgId.toHexString(), () => this.stop(link.phone, 'link'), {
      type: 'anonymous',
      id: 'opt-out-link',
    });
    return true;
  }

  private async findLink(code: string) {
    if (!/^[A-Za-z0-9]{6,16}$/.test(code)) return null;
    return this.linkModel
      .findOne({ code }, null, { [CROSS_TENANT]: true })
      .lean()
      .exec();
  }
}
