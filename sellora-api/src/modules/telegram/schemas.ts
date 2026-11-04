import { Schema } from 'mongoose';
import { platformSchema, type WithId } from '../../infra/database/schema-helpers.js';
import type { PlatformPermission } from '../iam/platform-permissions.js';

/** What a chat can get (ADR 0022). Each needs a platform permission of the admin who linked it. */
export const TOPICS = {
  reports: {
    label: 'Daily, weekly and monthly reports',
    permission: 'platform.billing.view',
  },
  backups: { label: 'Backup alerts', permission: 'platform.backups.manage' },
  billing: { label: 'Payment alerts', permission: 'platform.billing.view' },
  ai: { label: 'AI provider and spend alerts', permission: 'platform.billing.view' },
  security: { label: 'Sign-in failure spikes', permission: 'platform.audit.view' },
  system: { label: 'Queue backlog and server status', permission: 'platform.tenants.view' },
} as const satisfies Record<string, { label: string; permission: PlatformPermission }>;
export type Topic = keyof typeof TOPICS;
export const TOPIC_KEYS = Object.keys(TOPICS) as Topic[];

export interface TelegramChatEntry {
  /** Telegram's chat id, as text (group ids are negative and can be large). */
  chatId: string;
  title: string;
  kind: 'private' | 'group' | 'supergroup' | 'channel';
  topics: Topic[];
  status: 'active' | 'unreachable';
  /** The admin who linked it; topics are limited to what their permissions allow. */
  addedBy: { id: string; label?: string };
  addedAt: Date;
  lastError?: string;
}

export interface TelegramSettings {
  _id: string;
  chats: TelegramChatEntry[];
  reports: {
    daily: boolean;
    weekly: boolean;
    monthly: boolean;
    hour: number;
    timezone: string;
  };
  alerts: {
    enabled: boolean;
    /** Waiting jobs in one queue that count as a backlog. */
    queueBacklog: number;
    /** Failed sign-ins across the platform in 15 minutes. */
    loginFailures: number;
    /** AI provider errors in 15 minutes. */
    aiErrors: number;
    /** Today's AI cost over this many times the 7-day daily average. */
    aiSpendFactor: number;
    /** Email the platform's owners when Telegram cannot take an alert. */
    emailFallback: boolean;
  };
  webhook?: { url: string; secretHash: string; connectedAt: Date };
  /** The report slots already sent, so a report goes once. */
  sent?: { daily?: Date; weekly?: Date; monthly?: Date };
  updatedAt?: Date;
}

const chat = new Schema<TelegramChatEntry>(
  {
    chatId: { type: String, required: true },
    title: { type: String, required: true },
    kind: { type: String, enum: ['private', 'group', 'supergroup', 'channel'], required: true },
    topics: [{ type: String, enum: Object.keys(TOPICS) }],
    status: { type: String, enum: ['active', 'unreachable'], default: 'active' },
    addedBy: { id: String, label: String },
    addedAt: { type: Date, required: true },
    lastError: String,
  },
  { _id: false },
);

export const TelegramSettingsSchema = platformSchema<TelegramSettings>(
  {
    _id: { type: String, required: true },
    chats: { type: [chat], default: [] },
    reports: {
      daily: { type: Boolean, default: true },
      weekly: { type: Boolean, default: true },
      monthly: { type: Boolean, default: true },
      hour: { type: Number, default: 21, min: 0, max: 23 },
      timezone: { type: String, required: true },
    },
    alerts: {
      enabled: { type: Boolean, default: true },
      queueBacklog: { type: Number, default: 500 },
      loginFailures: { type: Number, default: 50 },
      aiErrors: { type: Number, default: 20 },
      aiSpendFactor: { type: Number, default: 3 },
      emailFallback: { type: Boolean, default: true },
    },
    webhook: { url: String, secretHash: String, connectedAt: Date },
    sent: { daily: Date, weekly: Date, monthly: Date },
  },
  { collection: 'telegram_settings', minimize: false },
);

export interface TelegramMessage {
  chatId: string;
  topic: Topic | 'command' | 'test';
  kind: 'alert' | 'report' | 'reply' | 'test';
  /** HTML (Telegram's HTML mode). */
  text: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  error?: string;
  /** The alert it carries, for the email fallback. */
  alertKey?: string;
  telegramMessageId?: number;
  createdAt: Date;
  sentAt?: Date;
  expiresAt: Date;
}
export type TelegramMessageDoc = WithId<TelegramMessage>;

export const TelegramMessageSchema = platformSchema<TelegramMessage>(
  {
    chatId: { type: String, required: true },
    topic: { type: String, required: true },
    kind: { type: String, enum: ['alert', 'report', 'reply', 'test'], required: true },
    text: { type: String, required: true },
    status: { type: String, enum: ['queued', 'sent', 'failed', 'skipped'], required: true },
    attempts: { type: Number, default: 0 },
    error: String,
    alertKey: String,
    telegramMessageId: Number,
    createdAt: { type: Date, required: true },
    sentAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { collection: 'telegram_messages' },
);
TelegramMessageSchema.index({ createdAt: -1 });
TelegramMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** An hourly count kept for reports (for example chats the AI handed to people). */
export interface PlatformCount {
  /** `<name>:<hour as ISO>`. */
  _id: string;
  name: string;
  hour: Date;
  count: number;
  expiresAt: Date;
}

export const PlatformCountSchema = platformSchema<PlatformCount>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    hour: { type: Date, required: true },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'platform_counts' },
);
PlatformCountSchema.index({ name: 1, hour: 1 });
PlatformCountSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
