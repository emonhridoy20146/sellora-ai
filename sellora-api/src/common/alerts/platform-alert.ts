/**
 * Alerts for the platform's owners (ADR 0022). Any module emits these on the event bus; the
 * Telegram module sends them to the chats that take the topic, or emails the owners. The
 * emitter never waits on delivery and never fails because of it.
 */
export const PLATFORM_ALERT = 'platform.alert';

/** Something counted toward a spike alert (for example one AI provider error). */
export const PLATFORM_SIGNAL = 'platform.signal';

export type AlertTopic = 'backups' | 'billing' | 'ai' | 'security' | 'system';

export interface PlatformAlertEvent {
  topic: AlertTopic;
  /** Alerts with the same key within the grouping window are sent once (ADR 0022). */
  key: string;
  /** One line, plain text (escaped when sent). */
  title: string;
  /** Plain text detail lines. Counts and ids only: never customers' names, phones or messages. */
  lines?: string[];
  level?: 'warning' | 'critical';
  /** How long repeats are held back; default 30 minutes. */
  groupForMs?: number;
}

export type SignalKind = 'ai_error';

export interface PlatformSignalEvent {
  kind: SignalKind;
  /** What it was, for the alert's detail (no customer data). */
  detail: string;
}
