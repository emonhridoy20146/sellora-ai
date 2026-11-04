import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Model } from 'mongoose';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import {
  TelegramClient,
  TelegramError,
  escapeHtml,
  type TelegramChat,
  type TelegramUpdate,
} from '../../infra/telegram/telegram.client.js';
import { AuditService } from '../audit/audit.service.js';
import { PLATFORM_ROLE_PERMISSIONS } from '../iam/platform-permissions.js';
import type { PlatformUser } from '../platform/platform-user.schema.js';
import {
  TOPICS,
  TOPIC_KEYS,
  type TelegramChatEntry,
  type TelegramMessage,
  type TelegramMessageDoc,
  type TelegramSettings,
  type Topic,
} from './schemas.js';

const SETTINGS_ID = 'global';
const LINK_CODE_SECONDS = 15 * 60;
const KEEP_MESSAGES_MS = 90 * 24 * 3600_000;
export const TELEGRAM_JOBS = { deliver: 'deliver', update: 'update', sweep: 'sweep' } as const;
/** The tries a message gets before it counts as failed. */
export const DELIVERY_ATTEMPTS = 5;

export type ChatDto = Omit<TelegramChatEntry, 'addedAt'> & {
  addedAt: string;
  /** Topics the chat asked for that its admin may no longer get. */
  blockedTopics: Topic[];
};

/** Who an admin is, for linking chats. */
export interface AdminRef {
  id: string;
  label?: string;
}

/**
 * Owner reports and alerts on Telegram (ADR 0022): the allowed chats, the webhook, the
 * outbox of messages and their delivery.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    @InjectModel('TelegramSettings') private readonly settingsModel: Model<TelegramSettings>,
    @InjectModel('TelegramMessage') private readonly messages: Model<TelegramMessage>,
    @InjectModel('PlatformUser') private readonly admins: Model<PlatformUser>,
    private readonly client: TelegramClient,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(QUEUES.telegram) private readonly queue: Queue,
  ) {}

  get configured(): boolean {
    return this.client.configured;
  }

  // ---------------------------------------------------------------- settings

  async settings(): Promise<TelegramSettings> {
    const found = await this.settingsModel.findById(SETTINGS_ID).lean<TelegramSettings>().exec();
    if (found) return found;
    return await this.settingsModel
      .findOneAndUpdate(
        { _id: SETTINGS_ID },
        // A dotted path, so the other report defaults are still filled in on insert.
        { $setOnInsert: { 'reports.timezone': this.config.get('PLATFORM_REPORT_TIMEZONE') } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .lean<TelegramSettings>()
      .exec();
  }

  async updateSettings(
    patch: {
      reports?: Partial<TelegramSettings['reports']>;
      alerts?: Partial<TelegramSettings['alerts']>;
    },
    by: AdminRef,
  ): Promise<TelegramSettings> {
    await this.settings();
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch.reports ?? {}))
      if (v !== undefined) set[`reports.${k}`] = v;
    for (const [k, v] of Object.entries(patch.alerts ?? {}))
      if (v !== undefined) set[`alerts.${k}`] = v;
    if (patch.reports?.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: patch.reports.timezone });
      } catch {
        throw AppError.validation([{ path: 'reports.timezone', message: 'Unknown time zone' }]);
      }
    }
    const doc = await this.settingsModel
      .findOneAndUpdate({ _id: SETTINGS_ID }, { $set: set }, { returnDocument: 'after' })
      .lean<TelegramSettings>()
      .exec();
    await this.audit.record({
      action: 'platform.telegram.settings_changed',
      actor: { type: 'platform', id: by.id, ...(by.label ? { label: by.label } : {}) },
      target: { type: 'telegram', id: SETTINGS_ID, label: 'Telegram settings' },
      metadata: set,
    });
    return doc!;
  }

  /** Permissions of each admin who linked a chat (disabled admins have none). */
  private async adminPermissions(ids: string[]): Promise<Map<string, Set<string>>> {
    const valid = [...new Set(ids)].filter((id) => /^[a-f0-9]{24}$/.test(id));
    const rows = await this.admins
      .find({ _id: { $in: valid } }, { role: 1, status: 1 })
      .lean<(PlatformUser & { _id: { toHexString(): string } })[]>()
      .exec();
    return new Map(
      rows.map((u) => [
        u._id.toHexString(),
        new Set(u.status === 'active' ? PLATFORM_ROLE_PERMISSIONS[u.role] : []),
      ]),
    );
  }

  async chats(): Promise<ChatDto[]> {
    const s = await this.settings();
    const perms = await this.adminPermissions(s.chats.map((c) => c.addedBy.id));
    return s.chats.map((c) => ({
      ...c,
      addedAt: c.addedAt.toISOString(),
      blockedTopics: c.topics.filter((t) => !perms.get(c.addedBy.id)?.has(TOPICS[t].permission)),
    }));
  }

  /** The active chats that take `topic`, as their admins' permissions allow today. */
  async chatsFor(topic: Topic): Promise<TelegramChatEntry[]> {
    const s = await this.settings();
    const candidates = s.chats.filter((c) => c.status === 'active' && c.topics.includes(topic));
    if (!candidates.length) return [];
    const perms = await this.adminPermissions(candidates.map((c) => c.addedBy.id));
    return candidates.filter((c) => perms.get(c.addedBy.id)?.has(TOPICS[topic].permission));
  }

  /** Topics an admin may give a chat. */
  allowedTopics(role: PlatformUser['role']): Topic[] {
    const perms = new Set<string>(PLATFORM_ROLE_PERMISSIONS[role]);
    return TOPIC_KEYS.filter((t) => perms.has(TOPICS[t].permission));
  }

  private async adminRole(id: string): Promise<PlatformUser['role']> {
    const admin = /^[a-f0-9]{24}$/.test(id)
      ? await this.admins.findById(id, { role: 1, status: 1 }).lean<PlatformUser>().exec()
      : null;
    if (!admin || admin.status !== 'active') throw AppError.forbidden('not_allowed', 'Not allowed');
    return admin.role;
  }

  async setChatTopics(chatId: string, topics: Topic[], by: AdminRef): Promise<ChatDto[]> {
    const allowed = this.allowedTopics(await this.adminRole(by.id));
    const bad = topics.filter((t) => !allowed.includes(t));
    if (bad.length)
      throw AppError.validation([
        {
          path: 'topics',
          message: `Your role cannot give a chat: ${bad.map((t) => TOPICS[t].label).join(', ')}`,
        },
      ]);
    const res = await this.settingsModel.updateOne(
      { _id: SETTINGS_ID, 'chats.chatId': chatId },
      // The chat now takes these topics on this admin's permissions.
      {
        $set: {
          'chats.$.topics': [...new Set(topics)],
          'chats.$.addedBy': { id: by.id, label: by.label },
        },
      },
    );
    if (!res.matchedCount) throw AppError.notFound('chat');
    await this.audit.record({
      action: 'platform.telegram.chat_changed',
      actor: { type: 'platform', id: by.id, ...(by.label ? { label: by.label } : {}) },
      target: { type: 'telegram_chat', id: chatId },
      metadata: { topics },
    });
    return this.chats();
  }

  async removeChat(chatId: string, by: AdminRef): Promise<void> {
    // Matched, not modified: timestamps make every update a modification.
    const res = await this.settingsModel.updateOne(
      { _id: SETTINGS_ID, 'chats.chatId': chatId },
      { $pull: { chats: { chatId } } },
    );
    if (!res.matchedCount) throw AppError.notFound('chat');
    await this.audit.record({
      action: 'platform.telegram.chat_removed',
      actor: { type: 'platform', id: by.id, ...(by.label ? { label: by.label } : {}) },
      target: { type: 'telegram_chat', id: chatId },
    });
  }

  private async addChat(chat: TelegramChat, by: AdminRef): Promise<TelegramChatEntry> {
    const role = await this.adminRole(by.id);
    const entry: TelegramChatEntry = {
      chatId: String(chat.id),
      title: chatTitle(chat),
      kind: chat.type,
      topics: this.allowedTopics(role),
      status: 'active',
      addedBy: { id: by.id, ...(by.label ? { label: by.label } : {}) },
      addedAt: new Date(),
    };
    await this.settings();
    await this.settingsModel.updateOne(
      { _id: SETTINGS_ID },
      { $pull: { chats: { chatId: entry.chatId } } },
    );
    await this.settingsModel.updateOne({ _id: SETTINGS_ID }, { $push: { chats: entry } });
    await this.audit.record({
      action: 'platform.telegram.chat_added',
      actor: { type: 'platform', id: by.id, ...(by.label ? { label: by.label } : {}) },
      target: { type: 'telegram_chat', id: entry.chatId, label: entry.title },
      metadata: { kind: entry.kind, topics: entry.topics },
    });
    return entry;
  }

  /** Adds a chat by its id, once a test message reaches it. */
  async addChatById(chatId: string, by: AdminRef): Promise<ChatDto[]> {
    this.assertConfigured();
    let chat: TelegramChat;
    try {
      chat = await this.client.getChat(chatId);
      await this.client.sendMessage(
        String(chat.id),
        '✅ This chat now gets Sellora owner reports and alerts. Send /help for the commands.',
      );
    } catch (err) {
      if (err instanceof TelegramError && (err.kind === 'chat_gone' || err.kind === 'other'))
        throw AppError.validation([
          {
            path: 'chatId',
            message:
              'The bot cannot write to this chat. Start a chat with the bot (or add it to the group) first.',
          },
        ]);
      throw telegramUnavailable(err);
    }
    await this.addChat(chat, by);
    return this.chats();
  }

  // ---------------------------------------------------------------- linking

  private assertConfigured(): void {
    if (!this.configured)
      throw AppError.conflict(
        'telegram_not_configured',
        'Telegram is not set up on this server (TELEGRAM_BOT_TOKEN).',
      );
  }

  /** A single-use code an admin sends to the bot from the chat to add it. */
  async linkCode(by: AdminRef): Promise<{
    code: string;
    expiresAt: string;
    botUsername: string | null;
    startUrl: string | null;
  }> {
    this.assertConfigured();
    await this.adminRole(by.id);
    const code = randomBytes(6).toString('hex');
    await this.redis.set(`tg-link:${code}`, JSON.stringify(by), 'EX', LINK_CODE_SECONDS);
    const me = await this.client.getMe().catch(() => null);
    return {
      code,
      expiresAt: new Date(Date.now() + LINK_CODE_SECONDS * 1000).toISOString(),
      botUsername: me?.username ?? null,
      startUrl: me?.username ? `https://t.me/${me.username}?start=${code}` : null,
    };
  }

  // ---------------------------------------------------------------- the webhook

  webhookUrl(): string {
    return `${this.config.get('API_PUBLIC_URL').replace(/\/+$/, '')}/v1/telegram/webhook`;
  }

  async connectWebhook(by: AdminRef): Promise<{ url: string }> {
    this.assertConfigured();
    const secret = randomBytes(24).toString('base64url');
    const url = this.webhookUrl();
    try {
      await this.client.setWebhook(url, secret);
    } catch (err) {
      throw telegramUnavailable(err);
    }
    await this.settings();
    await this.settingsModel.updateOne(
      { _id: SETTINGS_ID },
      { $set: { webhook: { url, secretHash: sha256(secret), connectedAt: new Date() } } },
    );
    await this.audit.record({
      action: 'platform.telegram.webhook_connected',
      actor: { type: 'platform', id: by.id, ...(by.label ? { label: by.label } : {}) },
      target: { type: 'telegram', id: SETTINGS_ID, label: url },
    });
    return { url };
  }

  async disconnectWebhook(by: AdminRef): Promise<void> {
    if (this.configured) await this.client.deleteWebhook().catch(() => undefined);
    await this.settingsModel.updateOne({ _id: SETTINGS_ID }, { $unset: { webhook: 1 } });
    await this.audit.record({
      action: 'platform.telegram.webhook_disconnected',
      actor: { type: 'platform', id: by.id, ...(by.label ? { label: by.label } : {}) },
      target: { type: 'telegram', id: SETTINGS_ID },
    });
  }

  /** Whether the secret Telegram sent is the one set with the webhook. */
  async checkWebhookSecret(secret: string | undefined): Promise<boolean> {
    if (!secret) return false;
    const s = await this.settings();
    if (!s.webhook?.secretHash) return false;
    const a = Buffer.from(sha256(secret), 'hex');
    const b = Buffer.from(s.webhook.secretHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The webhook's part: the worker reads the update. Duplicates (Telegram retries) once. */
  async acceptUpdate(update: TelegramUpdate): Promise<void> {
    if (typeof update.update_id !== 'number' || !update.message?.chat) return;
    await this.queue.add(
      TELEGRAM_JOBS.update,
      { update },
      { jobId: `update-${update.update_id}`, attempts: 2, removeOnComplete: { age: 3600 } },
    );
  }

  /**
   * Links a chat from `/start <code>` or `/link <code>`. Returns whether the text was a link
   * attempt (answered here), so commands are not read from chats that are not allowed.
   */
  async tryLink(update: TelegramUpdate): Promise<boolean> {
    const m = update.message!;
    const match = /^\/(?:start|link)(?:@\w+)?\s+([a-f0-9]{12})\s*$/i.exec(m.text ?? '');
    if (!match) return false;
    const saved = await this.redis.getdel(`tg-link:${match[1]!.toLowerCase()}`);
    if (!saved) {
      await this.reply(
        String(m.chat.id),
        'This link code has expired or was used. Make a new one in Admin › Telegram.',
      );
      return true;
    }
    const by = JSON.parse(saved) as AdminRef;
    try {
      const entry = await this.addChat(m.chat, by);
      await this.reply(
        entry.chatId,
        [
          '✅ <b>Connected to Sellora.</b>',
          `This chat gets: ${entry.topics.map((t) => TOPICS[t].label.toLowerCase()).join(', ') || 'nothing yet'}.`,
          'Change it in Admin › Telegram. Send /help for the commands.',
        ].join('\n'),
      );
    } catch {
      await this.reply(String(m.chat.id), 'The admin who made this code can no longer add chats.');
    }
    return true;
  }

  async isAllowed(chatId: string): Promise<TelegramChatEntry | null> {
    const s = await this.settings();
    return s.chats.find((c) => c.chatId === chatId) ?? null;
  }

  // ---------------------------------------------------------------- the outbox

  /** Queues a message to one chat. */
  async enqueue(
    chatId: string,
    topic: TelegramMessage['topic'],
    kind: TelegramMessage['kind'],
    text: string,
    alertKey?: string,
  ): Promise<TelegramMessageDoc> {
    const now = new Date();
    const doc = (
      await this.messages.create({
        chatId,
        topic,
        kind,
        text,
        status: 'queued',
        attempts: 0,
        ...(alertKey ? { alertKey } : {}),
        createdAt: now,
        expiresAt: new Date(now.getTime() + KEEP_MESSAGES_MS),
      })
    ).toObject() as unknown as TelegramMessageDoc;
    const id = doc._id.toHexString();
    await this.queue.add(
      TELEGRAM_JOBS.deliver,
      { messageId: id },
      { jobId: `deliver-${id}`, attempts: 1, removeOnComplete: { age: 3600 } },
    );
    return doc;
  }

  /** Queues `text` to every chat that takes `topic`. Returns how many chats. */
  async toTopic(
    topic: Topic,
    kind: TelegramMessage['kind'],
    text: string,
    alertKey?: string,
  ): Promise<number> {
    if (!this.configured) return 0;
    const chats = await this.chatsFor(topic);
    for (const c of chats) await this.enqueue(c.chatId, topic, kind, text, alertKey);
    return chats.length;
  }

  reply(chatId: string, text: string): Promise<TelegramMessageDoc> {
    return this.enqueue(chatId, 'command', 'reply', text);
  }

  /**
   * The worker's part: sends one message. On 429 it waits as Telegram asks and tries again
   * (up to 5 tries); a chat that blocked the bot is marked unreachable. Returns the outcome.
   */
  async deliver(messageId: string): Promise<{
    status: TelegramMessage['status'];
    retryInMs?: number;
    failed?: TelegramMessageDoc;
  }> {
    const m = await this.messages.findById(messageId).lean<TelegramMessageDoc>().exec();
    if (!m || m.status !== 'queued') return { status: m?.status ?? 'skipped' };
    const chat = await this.isAllowed(m.chatId);
    if (m.kind !== 'reply' && m.kind !== 'test' && (!chat || chat.status !== 'active')) {
      await this.messages.updateOne(
        { _id: m._id },
        { $set: { status: 'skipped', error: 'The chat is not in the list' } },
      );
      return { status: 'skipped' };
    }
    try {
      const sent = await this.client.sendMessage(m.chatId, m.text);
      await this.messages.updateOne(
        { _id: m._id },
        {
          $set: { status: 'sent', sentAt: new Date(), telegramMessageId: sent.messageId },
          $inc: { attempts: 1 },
          $unset: { error: 1 },
        },
      );
      return { status: 'sent' };
    } catch (err) {
      const e = err instanceof TelegramError ? err : new TelegramError('other', String(err));
      const attempts = m.attempts + 1;
      if (e.kind === 'retry' && attempts < DELIVERY_ATTEMPTS) {
        const retryInMs = Math.min(Math.max(e.retryAfter, 1), 3600) * 1000;
        await this.messages.updateOne(
          { _id: m._id },
          { $set: { error: e.message.slice(0, 300), attempts } },
        );
        await this.queue.add(
          TELEGRAM_JOBS.deliver,
          { messageId },
          {
            jobId: `deliver-${messageId}-${attempts}`,
            delay: retryInMs,
            attempts: 1,
            removeOnComplete: { age: 3600 },
          },
        );
        return { status: 'queued', retryInMs };
      }
      const error = e.message.slice(0, 300);
      await this.messages.updateOne(
        { _id: m._id },
        { $set: { status: 'failed', error, attempts } },
      );
      if (e.kind === 'chat_gone')
        await this.settingsModel.updateOne(
          { _id: SETTINGS_ID, 'chats.chatId': m.chatId },
          {
            $set: { 'chats.$.status': 'unreachable', 'chats.$.lastError': e.message.slice(0, 300) },
          },
        );
      this.logger.warn(
        { chatId: m.chatId, kind: e.kind, err: e.message },
        'Telegram message failed',
      );
      return { status: 'failed', failed: { ...m, status: 'failed', error, attempts } };
    }
  }

  /** The latest messages, newest first. */
  async recent(limit = 50) {
    const rows = await this.messages
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<TelegramMessageDoc[]>()
      .exec();
    return rows.map((m) => ({
      id: m._id.toHexString(),
      chatId: m.chatId,
      topic: m.topic,
      kind: m.kind,
      text: m.text,
      status: m.status,
      attempts: m.attempts,
      error: m.error ?? null,
      createdAt: m.createdAt.toISOString(),
      sentAt: m.sentAt?.toISOString() ?? null,
    }));
  }

  /** Marks a chat reachable again (after the admin unblocked the bot) and sends a test. */
  async sendTest(chatId: string, by: AdminRef): Promise<void> {
    this.assertConfigured();
    const chat = await this.isAllowed(chatId);
    if (!chat) throw AppError.notFound('chat');
    await this.settingsModel.updateOne(
      { _id: SETTINGS_ID, 'chats.chatId': chatId },
      { $set: { 'chats.$.status': 'active' }, $unset: { 'chats.$.lastError': 1 } },
    );
    await this.enqueue(
      chatId,
      'test',
      'test',
      `🔔 Test from Sellora, sent by ${escapeHtml(by.label ?? 'an admin')}. This chat gets: ${chat.topics.map((t) => TOPICS[t].label.toLowerCase()).join(', ') || 'nothing'}.`,
    );
  }

  /** Notes in the audit log that an admin sent a report by hand. */
  async recordReportSent(kind: string, chats: number, by: AdminRef): Promise<void> {
    await this.audit.record({
      action: 'platform.telegram.report_sent',
      actor: { type: 'platform', id: by.id, ...(by.label ? { label: by.label } : {}) },
      target: { type: 'telegram', id: SETTINGS_ID, label: `${kind} report` },
      metadata: { kind, chats },
    });
  }

  /** What the page shows about the bot. */
  async status() {
    const s = await this.settings();
    let bot: { username: string; name: string } | null = null;
    let problem: string | null = null;
    let webhook: { url: string; pending: number; lastError: string | null } | null = null;
    if (this.configured) {
      try {
        const me = await this.client.getMe();
        bot = { username: me.username, name: me.first_name };
        const info = await this.client.getWebhookInfo();
        webhook = info.url
          ? {
              url: info.url,
              pending: info.pending_update_count,
              lastError: info.last_error_message ?? null,
            }
          : null;
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      configured: this.configured,
      bot,
      problem,
      webhook,
      webhookConnectedAt: s.webhook?.connectedAt?.toISOString() ?? null,
      webhookUrl: this.webhookUrl(),
    };
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function chatTitle(chat: TelegramChat): string {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  return name || (chat.username ? `@${chat.username}` : String(chat.id));
}

function telegramUnavailable(err: unknown): AppError {
  const message = err instanceof Error ? err.message : String(err);
  return AppError.conflict('telegram_unavailable', `Telegram did not accept this: ${message}`);
}
