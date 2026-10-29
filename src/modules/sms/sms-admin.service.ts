import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model, type PipelineStage } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { normalizePhone } from '../../common/validation/schemas.js';
import { AppConfig } from '../../config/app-config.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import { MailService } from '../../infra/mail/mail.service.js';
import { mailTemplates, type RenderedMail } from '../../infra/mail/templates.js';
import { AuditService } from '../audit/audit.service.js';
import type { Organization } from '../orgs/schemas.js';
import { UsersService } from '../users/users.service.js';
import { SmsSettingsRepository, type SmsSettingsDoc } from './repositories.js';
import type { SenderNameStatus, SmsMessage, SmsSettings } from './schemas.js';
import { smsLength } from './segments.js';
import { SmsProviders } from './providers/sms-providers.js';
import { SmsPlatformService } from './sms-platform.service.js';
import { SmsService } from './sms.service.js';
import { SmsError, canReach } from './sms.types.js';

export interface SmsStatsRow {
  day: string;
  currency: string;
  messages: number;
  parts: number;
  revenueMinor: number;
  costMinor: number;
  profitMinor: number;
}

/**
 * The super-admin's side of SMS (ADR 0017): sender names to approve, each business's daily
 * limit, and what Sellora SMS earned and cost. Reads cross businesses; each change runs in
 * that business, is audited there, and the owner hears about sender-name decisions by email.
 */
@Injectable()
export class SmsAdminService {
  private readonly logger = new Logger(SmsAdminService.name);

  constructor(
    @InjectModel('SmsSettings') private readonly settingsModel: Model<SmsSettings>,
    @InjectModel('SmsMessage') private readonly messageModel: Model<SmsMessage>,
    @InjectModel('Organization') private readonly orgModel: Model<Organization>,
    private readonly settings: SmsSettingsRepository,
    private readonly platform: SmsPlatformService,
    private readonly providers: SmsProviders,
    private readonly sms: SmsService,
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private get timezone(): string {
    return this.config.get('PLATFORM_REPORT_TIMEZONE');
  }

  private settingsUrl(orgId: string): string {
    const web = this.config.get('WEB_APP_URL').replace(/\/$/, '');
    return `${web}/app/${orgId}/settings/sms`;
  }

  private async orgNames(
    ids: Types.ObjectId[],
  ): Promise<Map<string, Organization & { _id: Types.ObjectId }>> {
    if (!ids.length) return new Map();
    const orgs = await this.orgModel
      .find({ _id: { $in: ids } }, { name: 1, slug: 1, ownerUserId: 1, currency: 1 })
      .lean<(Organization & { _id: Types.ObjectId })[]>()
      .exec();
    return new Map(orgs.map((o) => [o._id.toHexString(), o]));
  }

  // ---------------------------------------------------------------- overview

  async overview() {
    const [platform, pendingSenderNames] = await Promise.all([
      this.platform.get(),
      this.settingsModel
        .countDocuments({ 'senderName.status': 'pending' }, { [CROSS_TENANT]: true })
        .exec(),
    ]);
    return {
      platform: this.platform.toDto(platform),
      pendingSenderNames,
      providers: this.providers.all().map((p) => p.descriptor),
    };
  }

  /** Sends one message from Sellora's own account (no business, no wallet), to check it works. */
  async testSend(input: { to: string; text?: string }) {
    const p = await this.platform.get();
    if (!p.provider || !p.credentialsEnc)
      throw AppError.unprocessable('sms_provider_missing', 'Connect an SMS provider first.');
    const to = normalizePhone(input.to, 'BD');
    if (!to) throw AppError.validation([{ path: 'to', message: 'Invalid phone number' }]);
    const provider = this.platform.provider({ ...p, provider: p.provider });
    if (!canReach(provider.descriptor.reach, to))
      throw AppError.validation([
        {
          path: 'to',
          message: `${provider.descriptor.name} only sends to Bangladeshi mobile numbers`,
        },
      ]);
    const text = (input.text?.trim() || 'Test message from Sellora SMS.').slice(0, 300);
    const length = smsLength(text);
    try {
      const result = await provider.send(
        this.platform.context(
          { ...p, provider: p.provider, credentialsEnc: p.credentialsEnc },
          p.senderId,
        ),
        {
          to,
          text,
          reference: `platform-test-${Date.now()}`,
          unicode: length.encoding === 'unicode',
        },
      );
      await this.audit.record({
        action: 'platform.sms.test_sent',
        metadata: { provider: p.provider, providerStatus: result.providerStatus },
      });
      return {
        ok: true,
        providerName: provider.descriptor.name,
        providerStatus: result.providerStatus,
        providerMessageId: result.providerMessageId ?? null,
        parts: length.parts,
      };
    } catch (err) {
      if (!(err instanceof SmsError)) throw err;
      return {
        ok: false,
        providerName: provider.descriptor.name,
        failure: err.kind,
        error: err.message,
        parts: length.parts,
      };
    }
  }

  // ---------------------------------------------------------------- sender names

  async senderNames(q: { status: SenderNameStatus | 'all'; limit: number }) {
    const filter =
      q.status === 'all' ? { senderName: { $exists: true } } : { 'senderName.status': q.status };
    const rows = await this.settingsModel
      .find(filter, null, { [CROSS_TENANT]: true })
      .sort(
        q.status === 'pending' ? { 'senderName.requestedAt': 1 } : { 'senderName.requestedAt': -1 },
      )
      .limit(q.limit)
      .lean<SmsSettingsDoc[]>()
      .exec();
    const orgs = await this.orgNames(rows.map((r) => r.orgId));
    return {
      items: rows.map((r) => {
        const org = orgs.get(r.orgId.toHexString());
        const n = r.senderName!;
        return {
          orgId: r.orgId.toHexString(),
          business: org ? { name: org.name, slug: org.slug } : null,
          name: n.name,
          status: n.status,
          reason: n.reason ?? null,
          requestedAt: n.requestedAt.toISOString(),
          decidedAt: n.decidedAt?.toISOString() ?? null,
          inUse: n.status === 'approved' && r.useSenderName && r.mode === 'sellora',
        };
      }),
    };
  }

  /**
   * Decides a pending sender name. `name` is the name the reviewer saw: if the business has
   * asked for another one since, nothing changes (409).
   */
  async decideSenderName(
    orgId: string,
    decision: { approve: true; name: string } | { approve: false; name: string; reason: string },
  ) {
    if (!Types.ObjectId.isValid(orgId)) throw AppError.notFound('sms_settings');
    const actor = RequestContext.actor();
    const updated = await RequestContext.withTenant(orgId, async () => {
      const s = await this.settings.findOne({});
      if (!s?.senderName)
        throw AppError.notFound('sender_name', 'This business has no sender name request.');
      if (s.senderName.name !== decision.name || s.senderName.status !== 'pending')
        throw AppError.conflict(
          'sender_name_changed',
          'The business changed or withdrew this request. Reload the list.',
          { name: s.senderName.name, status: s.senderName.status },
        );
      const after = await this.settings.findOneAndUpdate(
        { _id: s._id, 'senderName.name': decision.name, 'senderName.status': 'pending' },
        {
          $set: {
            'senderName.status': decision.approve ? 'approved' : 'rejected',
            'senderName.decidedAt': new Date(),
            'senderName.decidedBy': actor.id,
            ...(decision.approve ? {} : { 'senderName.reason': decision.reason }),
          },
          ...(decision.approve ? { $unset: { 'senderName.reason': 1 } } : {}),
        },
      );
      if (!after)
        throw AppError.conflict('sender_name_changed', 'The request changed. Reload the list.');
      await this.audit.record({
        action: decision.approve
          ? 'platform.sms.sender_name_approved'
          : 'platform.sms.sender_name_rejected',
        orgId,
        target: { type: 'sms_sender_name', id: orgId, label: decision.name },
        metadata: decision.approve
          ? { name: decision.name }
          : { name: decision.name, reason: decision.reason },
      });
      return after;
    });
    await this.notifyOwner(
      orgId,
      decision.approve ? 'sms.sender_approved' : 'sms.sender_rejected',
      (locale, businessName) =>
        decision.approve
          ? mailTemplates.smsSenderApproved(locale, {
              businessName,
              senderName: decision.name,
              settingsUrl: this.settingsUrl(orgId),
            })
          : mailTemplates.smsSenderRejected(locale, {
              businessName,
              senderName: decision.name,
              reason: decision.reason,
              settingsUrl: this.settingsUrl(orgId),
            }),
    );
    return { orgId, name: updated.senderName!.name, status: updated.senderName!.status };
  }

  /** Emails the business owner in their language. A mail failure never undoes the decision. */
  private async notifyOwner(
    orgId: string,
    category: string,
    render: (locale: 'en' | 'bn', businessName: string) => RenderedMail,
  ): Promise<void> {
    try {
      const org = (await this.orgNames([new Types.ObjectId(orgId)])).get(orgId);
      if (!org) return;
      const [owner] = await this.users.findByIds([org.ownerUserId]);
      if (!owner) return;
      await this.mail.send({ to: owner.email, category, ...render(owner.locale, org.name) });
    } catch (err) {
      this.logger.error({ err, orgId }, 'Could not email the business owner about SMS');
    }
  }

  // ---------------------------------------------------------------- businesses

  /** Businesses that set SMS up, with the last 30 days of messages and spend. */
  async businesses(now = new Date()) {
    const since = new Date(now.getTime() - 30 * 24 * 3600_000);
    const [settings, usage] = await Promise.all([
      this.settingsModel
        .find(
          {
            $or: [
              { mode: { $ne: 'off' } },
              { own: { $exists: true } },
              { dailyLimit: { $ne: null } },
            ],
          },
          { orgId: 1, mode: 1, own: 1, dailyLimit: 1, useSenderName: 1, senderName: 1 },
          { [CROSS_TENANT]: true },
        )
        .sort({ updatedAt: -1 })
        .limit(500)
        .lean<SmsSettingsDoc[]>()
        .exec(),
      this.messageModel
        .aggregate<{ _id: Types.ObjectId; messages: number; failed: number; spentMinor: number }>([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: '$orgId',
              messages: { $sum: 1 },
              failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
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
        ])
        .option({ [CROSS_TENANT]: true })
        .exec(),
    ]);
    const byOrg = new Map(usage.map((u) => [u._id.toHexString(), u]));
    const orgs = await this.orgNames(settings.map((s) => s.orgId));
    const defaultLimit = this.config.get('SMS_DAILY_LIMIT');
    return {
      defaultDailyLimit: defaultLimit,
      items: settings.map((s) => {
        const id = s.orgId.toHexString();
        const org = orgs.get(id);
        const u = byOrg.get(id);
        return {
          orgId: id,
          business: org ? { name: org.name, slug: org.slug, currency: org.currency } : null,
          mode: s.mode,
          ownProvider: s.own?.provider ?? null,
          senderName:
            s.senderName?.status === 'approved' && s.useSenderName ? s.senderName.name : null,
          dailyLimit: s.dailyLimit,
          effectiveDailyLimit: s.dailyLimit ?? defaultLimit,
          last30Days: {
            messages: u?.messages ?? 0,
            failed: u?.failed ?? 0,
            spentMinor: u?.spentMinor ?? 0,
          },
        };
      }),
    };
  }

  /** A business's own daily limit; null goes back to SMS_DAILY_LIMIT. */
  async setDailyLimit(orgId: string, dailyLimit: number | null) {
    if (!Types.ObjectId.isValid(orgId)) throw AppError.notFound('organization');
    const org = await this.orgModel.exists({ _id: new Types.ObjectId(orgId) }).exec();
    if (!org) throw AppError.notFound('organization');
    return RequestContext.withTenant(orgId, async () => {
      // A business that never opened Settings › SMS gets its (switched-off) settings now.
      const before = await this.sms.settings();
      const after = (await this.settings.findOneAndUpdate(
        { _id: before._id },
        { $set: { dailyLimit } },
      ))!;
      await this.audit.record({
        action: 'platform.sms.daily_limit_set',
        orgId,
        metadata: { from: before.dailyLimit, to: dailyLimit },
      });
      return {
        orgId,
        dailyLimit: after.dailyLimit,
        effectiveDailyLimit: after.dailyLimit ?? this.config.get('SMS_DAILY_LIMIT'),
      };
    });
  }

  // ---------------------------------------------------------------- stats

  /** Sellora SMS by day: messages, parts, what businesses paid, what it cost, and the profit. */
  async stats(from: Date, to: Date) {
    const pipeline: PipelineStage[] = [
      {
        $match: {
          route: 'sellora',
          status: { $in: ['sent', 'delivered'] },
          createdAt: { $gte: from, $lt: to },
        },
      },
      {
        $group: {
          _id: {
            day: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: this.timezone },
            },
            currency: '$currency',
          },
          messages: { $sum: 1 },
          parts: { $sum: '$parts' },
          revenueMinor: { $sum: '$priceMinor' },
          costMinor: { $sum: '$costMinor' },
        },
      },
      { $sort: { '_id.day': 1 } },
    ];
    const [rows, statuses] = await Promise.all([
      this.messageModel
        .aggregate<{
          _id: { day: string; currency: string };
          messages: number;
          parts: number;
          revenueMinor: number;
          costMinor: number;
        }>(pipeline)
        .option({ [CROSS_TENANT]: true })
        .exec(),
      this.messageModel
        .aggregate<{ _id: { route: string; status: string }; count: number }>([
          { $match: { createdAt: { $gte: from, $lt: to } } },
          { $group: { _id: { route: '$route', status: '$status' }, count: { $sum: 1 } } },
        ])
        .option({ [CROSS_TENANT]: true })
        .exec(),
    ]);
    const days: SmsStatsRow[] = rows.map((r) => ({
      day: r._id.day,
      currency: r._id.currency,
      messages: r.messages,
      parts: r.parts,
      revenueMinor: r.revenueMinor,
      costMinor: r.costMinor,
      profitMinor: r.revenueMinor - r.costMinor,
    }));
    const totals = new Map<string, Omit<SmsStatsRow, 'day'>>();
    for (const d of days) {
      const t = totals.get(d.currency) ?? {
        currency: d.currency,
        messages: 0,
        parts: 0,
        revenueMinor: 0,
        costMinor: 0,
        profitMinor: 0,
      };
      t.messages += d.messages;
      t.parts += d.parts;
      t.revenueMinor += d.revenueMinor;
      t.costMinor += d.costMinor;
      t.profitMinor += d.profitMinor;
      totals.set(d.currency, t);
    }
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      timezone: this.timezone,
      days,
      totals: [...totals.values()],
      byStatus: statuses.map((s) => ({ route: s._id.route, status: s._id.status, count: s.count })),
    };
  }
}
