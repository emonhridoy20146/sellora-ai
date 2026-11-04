import type { ChannelType } from './schemas.js';

/**
 * Meta lets a business message a customer freely for 24 hours after the customer's last
 * message (Messenger, Instagram and WhatsApp alike). After that only template or tagged
 * messages are allowed, which this app does not send. The website chat has no window.
 */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Channels whose replies go out through Meta's Graph API (and the outbox queue). */
export function sendsThroughMeta(type: ChannelType): boolean {
  return type !== 'web_chat';
}

/** When the business can no longer reply, or null when the channel has no window. */
export function replyWindowEndsAt(type: ChannelType, lastInboundAt?: Date | null): Date | null {
  if (!sendsThroughMeta(type)) return null;
  return new Date((lastInboundAt?.getTime() ?? 0) + REPLY_WINDOW_MS);
}

export function replyWindowOpen(
  type: ChannelType,
  lastInboundAt: Date | null | undefined,
  now = new Date(),
): boolean {
  const ends = replyWindowEndsAt(type, lastInboundAt);
  return ends === null || ends.getTime() > now.getTime();
}
