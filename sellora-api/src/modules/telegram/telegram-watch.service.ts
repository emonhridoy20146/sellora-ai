import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { AppConfig } from '../../config/app-config.js';
import type { TelegramUpdate } from '../../infra/telegram/telegram.client.js';
import { AlertsService } from './alerts.service.js';
import {
  REPORT_KINDS,
  ReportsService,
  reportHtml,
  reportPeriod,
  reportSlot,
  type ReportKind,
} from './reports.service.js';
import { TOPICS, type TelegramChatEntry, type TelegramSettings, type Topic } from './schemas.js';
import { TelegramService, type AdminRef } from './telegram.service.js';

const SETTINGS_ID = 'global';
/** A report due longer ago than this when nothing was ever sent is skipped (a new install). */
const FIRST_REPORT_GRACE_MS = 3600_000;
/** No verified platform backup for this long is an alert. */
const STALE_BACKUP_MS = 26 * 3600_000;
/** What "Send now" covers, in days up to now. */
const SEND_NOW_DAYS: Record<ReportKind, number> = { daily: 1, weekly: 7, monthly: 30 };
/** The spend spike needs at least this much (US dollars) today, so tiny days stay quiet. */
const SPEND_FLOOR_USD = 1;

const COMMANDS: { name: string; topic: Topic | null; help: string }[] = [
  { name: 'status', topic: 'system', help: 'queues, the last backup and this host' },
  { name: 'today', topic: 'reports', help: 'the day so far' },
  { name: 'backup', topic: 'backups', help: 'the last platform backups' },
  { name: 'servers', topic: 'system', help: "the worker's host: load, memory and disk" },
  { name: 'help', topic: null, help: 'this list' },
];

/**
 * The worker's side of owner reports (ADR 0022): the 5-minute sweep (due reports, queue
 * backlog, a missing backup, AI spend) and the bot's commands.
 */
@Injectable()
export class TelegramWatchService {
  private readonly logger = new Logger(TelegramWatchService.name);

  constructor(
    private readonly telegram: TelegramService,
    private readonly alerts: AlertsService,
    private readonly reports: ReportsService,
    private readonly config: AppConfig,
    @InjectModel('TelegramSettings') private readonly settingsModel: Model<TelegramSettings>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // ---------------------------------------------------------------- the sweep

  async sweep(now = new Date()): Promise<{ reports: ReportKind[]; alerts: string[] }> {
    const s = await this.telegram.settings();
    const sent: ReportKind[] = [];
    for (const kind of REPORT_KINDS) {
      try {
        if (await this.reportIfDue(kind, s, now)) sent.push(kind);
      } catch (err) {
        this.logger.error({ err, kind }, 'Report failed');
      }
    }
    const alerts: string[] = [];
    if (s.alerts.enabled) {
      for (const check of [
        () => this.checkBacklog(s),
        () => this.checkBackups(now),
        () => this.checkSpend(s, now),
      ]) {
        try {
          alerts.push(...(await check()));
        } catch (err) {
          this.logger.error({ err }, 'Alert check failed');
        }
      }
    }
    return { reports: sent, alerts };
  }

  /** Sends a report when its slot has come and no worker has claimed it yet. */
  private async reportIfDue(kind: ReportKind, s: TelegramSettings, now: Date): Promise<boolean> {
    if (!s.reports[kind] || !this.telegram.configured) return false;
    const tz = s.reports.timezone;
    const slot = reportSlot(kind, now, s.reports.hour, tz);
    const last = s.sent?.[kind];
    if (last && last.getTime() >= slot.getTime()) return false;
    const path = `sent.${kind}`;
    // Claimed atomically, so two workers send it once.
    const claim = await this.settingsModel.updateOne(
      {
        _id: SETTINGS_ID,
        $or: [{ [path]: { $lt: slot } }, { [path]: { $exists: false } }, { [path]: null }],
      },
      { $set: { [path]: slot } },
    );
    if (!claim.modifiedCount) return false;
    // A new install (or reports just turned on) starts with the next slot, not an old one.
    if (!last && now.getTime() - slot.getTime() > FIRST_REPORT_GRACE_MS) return false;
    if (!(await this.telegram.chatsFor('reports')).length) return false;
    const { from, to } = reportPeriod(kind, slot, tz);
    const data = await this.reports.collect(from, to, tz);
    await this.telegram.toTopic('reports', 'report', reportHtml(kind, data));
    return true;
  }

  /**
   * A report sent from Admin › Telegram: the 24 hours, 7 days or 30 days up to now. It does
   * not move the schedule.
   */
  async sendNow(kind: ReportKind, by: AdminRef): Promise<{ chats: number }> {
    const s = await this.telegram.settings();
    const tz = s.reports.timezone;
    const now = new Date();
    const days = SEND_NOW_DAYS[kind];
    const data = await this.reports.collect(new Date(now.getTime() - days * 86_400_000), now, tz);
    const chats = await this.telegram.toTopic('reports', 'report', reportHtml(kind, data));
    await this.telegram.recordReportSent(kind, chats, by);
    return { chats };
  }

  private async checkBacklog(s: TelegramSettings): Promise<string[]> {
    const raised: string[] = [];
    const threshold = s.alerts.queueBacklog;
    if (!(threshold > 0)) return raised;
    for (const q of await this.reports.queues()) {
      if (q.waiting < threshold) continue;
      const key = `queue-backlog-${q.name}`;
      await this.alerts.raise({
        topic: 'system',
        key,
        level: 'warning',
        title: `${q.waiting} jobs waiting in the ${q.name} queue`,
        lines: [
          `${q.active} running, ${q.delayed} delayed. The alert threshold is ${threshold}.`,
          'Check that the worker is running and keeping up.',
        ],
      });
      raised.push(key);
    }
    return raised;
  }

  /** No verified platform backup for 26 hours (while nightly backups are on). */
  private async checkBackups(now: Date): Promise<string[]> {
    const db = this.connection.db!;
    // Only read here; the backups module owns these collections (ADR 0020).
    const settings = await db
      .collection('backup_settings')
      .findOne<{ enabled?: boolean; createdAt?: Date }>({});
    if (!settings?.enabled) return [];
    const last = await db
      .collection('backup_runs')
      .find<{ verifiedAt?: Date; startedAt: Date }>({ scope: 'platform', status: 'verified' })
      .sort({ verifiedAt: -1 })
      .limit(1)
      .next();
    const since = last?.verifiedAt ?? settings.createdAt;
    if (!since || now.getTime() - since.getTime() < STALE_BACKUP_MS) return [];
    const hours = Math.floor((now.getTime() - since.getTime()) / 3600_000);
    await this.alerts.raise({
      topic: 'backups',
      key: 'backup-stale',
      level: 'critical',
      title: last
        ? `No verified platform backup for ${hours} hours`
        : 'No verified platform backup yet',
      lines: ['Open Admin › Backups to see the last runs, or start one with "Back up now".'],
      // Every 6 hours while it lasts, not every 30 minutes.
      groupForMs: 6 * 3600_000,
    });
    return ['backup-stale'];
  }

  /** Today's AI cost over N times the 7-day daily average: once a day. */
  private async checkSpend(s: TelegramSettings, now: Date): Promise<string[]> {
    const factor = s.alerts.aiSpendFactor;
    if (!(factor > 0)) return [];
    const { todayUsd, averageUsd } = await this.reports.aiSpend(now, s.reports.timezone);
    if (averageUsd <= 0 || todayUsd < SPEND_FLOOR_USD || todayUsd <= factor * averageUsd) return [];
    await this.alerts.raise({
      topic: 'ai',
      key: 'ai-spend-spike',
      level: 'warning',
      title: `AI cost today is ${(todayUsd / averageUsd).toFixed(1)}× the daily average`,
      lines: [
        `Today so far: $${todayUsd.toFixed(2)} · average of the last 7 days: $${averageUsd.toFixed(2)} a day.`,
        'See Admin › Billing › AI profit for the businesses and models.',
      ],
      groupForMs: 12 * 3600_000,
    });
    return ['ai-spend-spike'];
  }

  // ---------------------------------------------------------------- commands

  /** One update from Telegram: a link code, a command from an allowed chat, or nothing. */
  async handleUpdate(update: TelegramUpdate): Promise<'linked' | 'replied' | 'ignored'> {
    const m = update.message;
    if (!m?.chat || m.from?.is_bot) return 'ignored';
    if (await this.telegram.tryLink(update)) return 'linked';
    const match = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/i.exec(m.text ?? '');
    if (!match) return 'ignored';
    const chatId = String(m.chat.id);
    const chat = await this.telegram.isAllowed(chatId);
    // Chats not in the list get no answer at all (ADR 0022).
    if (!chat || chat.status !== 'active') return 'ignored';
    const name = match[1]!.toLowerCase();
    const command = COMMANDS.find((c) => c.name === name);
    const allowed = await this.allowedTopics(chat);
    if (!command || command.name === 'help') {
      await this.telegram.reply(chatId, this.helpText(allowed, command ? null : name));
      return 'replied';
    }
    if (command.topic && !allowed.includes(command.topic)) {
      await this.telegram.reply(
        chatId,
        `This chat does not get ${TOPICS[command.topic].label.toLowerCase()}, so /${command.name} is off here. Change it in Admin › Telegram.`,
      );
      return 'replied';
    }
    const tz = (await this.telegram.settings()).reports.timezone;
    let text: string;
    try {
      text =
        command.name === 'status'
          ? await this.reports.statusHtml(tz)
          : command.name === 'today'
            ? await this.reports.todayHtml(new Date(), tz)
            : command.name === 'backup'
              ? await this.reports.backupHtml(tz)
              : await this.reports.serversHtml();
    } catch (err) {
      this.logger.error({ err, command: command.name }, 'Command failed');
      text = 'Something went wrong reading that. Try again in a minute.';
    }
    await this.telegram.reply(chatId, text);
    return 'replied';
  }

  /** The topics this chat takes that its admin may still give. */
  private async allowedTopics(chat: TelegramChatEntry): Promise<Topic[]> {
    const out: Topic[] = [];
    for (const t of chat.topics)
      if ((await this.telegram.chatsFor(t)).some((c) => c.chatId === chat.chatId)) out.push(t);
    return out;
  }

  private helpText(allowed: Topic[], unknown: string | null): string {
    const lines = unknown ? [`I don't know /${unknown}.`, ''] : [];
    lines.push('<b>Sellora bot commands</b>');
    for (const c of COMMANDS) {
      const on = !c.topic || allowed.includes(c.topic);
      lines.push(`/${c.name} – ${c.help}${on ? '' : ' (off in this chat)'}`);
    }
    lines.push(
      '',
      'Reports and alerts come here on their own. Read-only: the bot changes nothing.',
    );
    return lines.join('\n');
  }
}
