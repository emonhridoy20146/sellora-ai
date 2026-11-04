import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Redis } from 'ioredis';
import type { Model } from 'mongoose';
import type { PlatformAlertEvent, SignalKind } from '../../common/alerts/platform-alert.js';
import { MailService } from '../../infra/mail/mail.service.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import { escapeHtml } from '../../infra/telegram/telegram.client.js';
import type { PlatformUser } from '../platform/platform-user.schema.js';
import type { PlatformCount, TelegramMessageDoc, TelegramSettings } from './schemas.js';
import { TelegramService } from './telegram.service.js';

/** Repeats of one alert within this time are held back and counted (ADR 0022). */
export const ALERT_GROUP_MS = 30 * 60_000;
/** Spikes (failed sign-ins, AI errors) are counted in windows of this length. */
export const SPIKE_WINDOW_MS = 15 * 60_000;
const SETTINGS_CACHE_MS = 15_000;
const HELD_COUNT_KEEP_MS = 7 * 24 * 3600_000;
const COUNTS_KEEP_MS = 400 * 24 * 3600_000;

export type AlertOutcome = 'telegram' | 'email' | 'held' | 'off' | 'nowhere';

const LEVEL_ICON = { critical: '🔴', warning: '🟠' } as const;

/** The alert as Telegram HTML. */
export function alertHtml(a: PlatformAlertEvent, heldBack: number): string {
  const lines = [
    `${LEVEL_ICON[a.level ?? 'warning']} <b>${escapeHtml(a.title)}</b>`,
    ...(a.lines ?? []).map(escapeHtml),
  ];
  if (heldBack > 0)
    lines.push(
      `<i>${heldBack} more like this ${heldBack === 1 ? 'was' : 'were'} held back since the last one.</i>`,
    );
  return lines.join('\n');
}

/** Telegram HTML as plain text, for the email fallback. */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Alerts for the platform's owners (ADR 0022): grouping of repeats, spike counters, and the
 * email fallback when Telegram is not set up, no chat takes the topic, or delivery fails.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private cached: { at: number; value: TelegramSettings } | null = null;

  constructor(
    private readonly telegram: TelegramService,
    private readonly mail: MailService,
    @InjectModel('PlatformUser') private readonly admins: Model<PlatformUser>,
    @InjectModel('PlatformCount') private readonly counts: Model<PlatformCount>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The settings, read at most every 15 seconds (sign-in failures can come fast). */
  private async settings(): Promise<TelegramSettings> {
    if (this.cached && Date.now() - this.cached.at < SETTINGS_CACHE_MS) return this.cached.value;
    const value = await this.telegram.settings();
    this.cached = { at: Date.now(), value };
    return value;
  }

  /** Forgets the cached settings (after they change). */
  forgetSettings(): void {
    this.cached = null;
  }

  /**
   * Sends an alert to the chats that take its topic, or emails the owners. A repeat within
   * the grouping window is held back and counted; the next one sent says how many.
   */
  async raise(a: PlatformAlertEvent, now = new Date()): Promise<AlertOutcome> {
    const s = await this.settings();
    if (!s.alerts.enabled) return 'off';
    const first = await this.redis.set(
      `tg-alert:${a.key}`,
      String(now.getTime()),
      'PX',
      a.groupForMs ?? ALERT_GROUP_MS,
      'NX',
    );
    if (first !== 'OK') {
      await this.redis
        .multi()
        .incr(`tg-alert-n:${a.key}`)
        .pexpire(`tg-alert-n:${a.key}`, HELD_COUNT_KEEP_MS)
        .exec();
      return 'held';
    }
    const heldBack = Number((await this.redis.getdel(`tg-alert-n:${a.key}`)) ?? 0);
    const chats = await this.telegram.toTopic(a.topic, 'alert', alertHtml(a, heldBack), a.key);
    if (chats > 0) return 'telegram';
    if (!s.alerts.emailFallback) return 'nowhere';
    const why = this.telegram.configured
      ? 'No Telegram chat takes these alerts, so it came by email.'
      : 'Telegram is not set up on this server, so it came by email.';
    const sent = await this.email(a.title, htmlToText(alertHtml(a, heldBack)), why);
    return sent ? 'email' : 'nowhere';
  }

  /**
   * An alert message Telegram did not take for good: the owners get it by email, once per
   * alert in the grouping window (several chats may have failed).
   */
  async deliveryFailed(m: TelegramMessageDoc): Promise<boolean> {
    if (m.kind !== 'alert' || !m.alertKey) return false;
    const s = await this.settings();
    if (!s.alerts.emailFallback) return false;
    const first = await this.redis.set(
      `tg-alert-mail:${m.alertKey}`,
      '1',
      'PX',
      ALERT_GROUP_MS,
      'NX',
    );
    if (first !== 'OK') return false;
    const text = htmlToText(m.text);
    return this.email(
      text.split('\n')[0]!.replace(/^\S+\s/, ''),
      text,
      `Telegram did not take this alert (${m.error ?? 'unknown error'}), so it came by email.`,
    );
  }

  /** Emails the active owners. Returns whether anyone was emailed. */
  private async email(title: string, text: string, why: string): Promise<boolean> {
    const owners = await this.admins
      .find({ role: 'owner', status: 'active' }, { email: 1 })
      .lean<Pick<PlatformUser, 'email'>[]>()
      .exec();
    if (!owners.length) {
      this.logger.warn({ title }, 'Alert not emailed: no active platform owner');
      return false;
    }
    const body = `${text}\n\n${why}\nChange alerts in Admin › Telegram.`;
    const html = body
      .split('\n')
      .map((l) => `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`)
      .join('');
    for (const o of owners)
      await this.mail
        .send({
          to: o.email,
          category: 'platform.alert',
          subject: `Sellora alert: ${title}`,
          text: body,
          html,
        })
        .catch((err: unknown) => this.logger.error({ err }, 'Alert email failed'));
    return true;
  }

  /**
   * Counts one event toward a spike. When the count in the current 15-minute window reaches
   * the threshold set in Admin › Telegram, an alert goes out (once per window).
   */
  async count(
    kind: SignalKind | 'login_failure',
    detail: string,
    now = new Date(),
  ): Promise<number> {
    const s = await this.settings();
    if (!s.alerts.enabled) return 0;
    const threshold = kind === 'login_failure' ? s.alerts.loginFailures : s.alerts.aiErrors;
    if (!(threshold > 0)) return 0;
    const bucket = Math.floor(now.getTime() / SPIKE_WINDOW_MS);
    const key = `tg-count:${kind}:${bucket}`;
    const detailKey = `tg-count-d:${kind}:${bucket}`;
    const res = await this.redis
      .multi()
      .incr(key)
      .pexpire(key, SPIKE_WINDOW_MS * 2)
      .hincrby(detailKey, detail.slice(0, 80), 1)
      .pexpire(detailKey, SPIKE_WINDOW_MS * 2)
      .exec();
    const n = Number(res?.[0]?.[1] ?? 0);
    if (n !== threshold) return n;
    const details = Object.entries(await this.redis.hgetall(detailKey))
      .map(([d, c]) => [d, Number(c)] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const minutes = SPIKE_WINDOW_MS / 60_000;
    await this.raise(
      kind === 'login_failure'
        ? {
            topic: 'security',
            key: 'spike-login-failure',
            level: 'warning',
            title: `${n} failed sign-ins in ${minutes} minutes`,
            lines: [
              ...details.map(([d, c]) => `${d}: ${c}`),
              'See Admin › Audit for the accounts and addresses.',
            ],
          }
        : {
            topic: 'ai',
            key: 'spike-ai-error',
            level: 'warning',
            title: `${n} AI provider errors in ${minutes} minutes`,
            lines: [
              ...details.map(([d, c]) => `${d}: ${c}`),
              'Replies that fail are tried again, then handed to the team.',
            ],
          },
      now,
    );
    return n;
  }

  // ---------------------------------------------------------------- hourly counts

  /** Adds one to an hourly count (for reports). */
  async add(name: string, at = new Date()): Promise<void> {
    const hour = new Date(Math.floor(at.getTime() / 3600_000) * 3600_000);
    await this.counts.updateOne(
      { _id: `${name}:${hour.toISOString()}` },
      {
        $inc: { count: 1 },
        $setOnInsert: { name, hour, expiresAt: new Date(hour.getTime() + COUNTS_KEEP_MS) },
      },
      { upsert: true },
    );
  }

  /** The sum of an hourly count over the hours that start in [from, to). */
  async sum(name: string, from: Date, to: Date): Promise<number> {
    const rows = await this.counts
      .aggregate<{ n: number }>([
        { $match: { name, hour: { $gte: from, $lt: to } } },
        { $group: { _id: null, n: { $sum: '$count' } } },
      ])
      .exec();
    return rows[0]?.n ?? 0;
  }
}
