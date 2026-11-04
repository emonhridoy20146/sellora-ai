import type { BadgeTone } from '@/components/ui/badge';
import type { TelegramChat, TelegramMessage, TelegramTopic } from '@/lib/api/types';

export const MESSAGE_STATUS: Record<TelegramMessage['status'], { label: string; tone: BadgeTone }> =
  {
    queued: { label: 'Queued', tone: 'info' },
    sent: { label: 'Sent', tone: 'success' },
    failed: { label: 'Failed', tone: 'danger' },
    skipped: { label: 'Skipped', tone: 'neutral' },
  };

export const MESSAGE_KIND: Record<TelegramMessage['kind'], string> = {
  alert: 'Alert',
  report: 'Report',
  reply: 'Reply to a command',
  test: 'Test',
};

export const CHAT_KIND: Record<TelegramChat['kind'], string> = {
  private: 'Private chat',
  group: 'Group',
  supergroup: 'Group',
  channel: 'Channel',
};

/** Telegram HTML (what the bot sent) as plain text, for previews. */
export function telegramText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Whether two topic lists hold the same topics, in any order. */
export function sameTopics(a: TelegramTopic[], b: TelegramTopic[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

/** A whole number from a form field, kept within [min, max]. */
export function wholeNumber(value: string, min: number, max: number): number {
  const n = Number.parseInt(value.replace(/[^\d]/g, '') || '0', 10);
  return Math.min(max, Math.max(min, n));
}

/** The command a group needs to link with a code (private chats use the start link). */
export function linkCommand(code: string): string {
  return `/link ${code}`;
}
