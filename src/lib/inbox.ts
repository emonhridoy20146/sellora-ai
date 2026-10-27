import type { ChannelType, Contact, Conversation, InboxMessage } from '@/lib/api/types';

export type InboxView = 'open' | 'mine' | 'unassigned' | 'paused' | 'closed';

export const INBOX_VIEWS: { value: InboxView; label: string; needsAll?: boolean }[] = [
  { value: 'open', label: 'Open' },
  { value: 'mine', label: 'Mine' },
  { value: 'unassigned', label: 'Unassigned', needsAll: true },
  { value: 'paused', label: 'AI paused' },
  { value: 'closed', label: 'Closed' },
];

/** The list query the API understands for a view. */
export function viewQuery(view: InboxView): Record<string, string> {
  switch (view) {
    case 'open':
      return { status: 'open' };
    case 'mine':
      return { status: 'open', assignee: 'me' };
    case 'unassigned':
      return { status: 'open', assignee: 'unassigned' };
    case 'paused':
      return { status: 'open', ai: 'paused' };
    case 'closed':
      return { status: 'closed' };
  }
}

/** Whether a conversation belongs in a view, so live updates can add or drop it. */
export function inView(c: Conversation, view: InboxView, meId: string): boolean {
  switch (view) {
    case 'open':
      return c.status === 'open';
    case 'mine':
      return c.status === 'open' && c.assigneeId === meId;
    case 'unassigned':
      return c.status === 'open' && c.assigneeId === null;
    case 'paused':
      return c.status === 'open' && c.ai.mode === 'paused';
    case 'closed':
      return c.status === 'closed';
  }
}

/**
 * Puts a changed conversation into a list: replaced or added when it belongs, dropped when it
 * no longer does, newest activity first.
 */
export function placeConversation(
  list: Conversation[],
  c: Conversation,
  belongs: boolean,
): Conversation[] {
  const rest = list.filter((x) => x.id !== c.id);
  if (!belongs) return rest;
  const at = Date.parse(c.lastMessageAt);
  const i = rest.findIndex((x) => Date.parse(x.lastMessageAt) < at);
  return i === -1 ? [...rest, c] : [...rest.slice(0, i), c, ...rest.slice(i)];
}

/** Adds a message to a newest-first list once (by id, or by the sender's clientId). */
export function addMessage(list: InboxMessage[], m: InboxMessage): InboxMessage[] {
  const i = list.findIndex((x) => x.id === m.id || (m.clientId && x.clientId === m.clientId));
  if (i !== -1) return list.map((x, j) => (j === i ? m : x));
  return [m, ...list];
}

export function contactLabel(contact: Contact | null | undefined): string {
  if (!contact) return 'Customer';
  return contact.name || contact.phone || contact.email || 'Website visitor';
}

export function initials(label: string): string {
  const words = label
    .replace(/[^\p{L}\p{M}\p{N} ]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  return (words[0]![0]! + (words[1]?.[0] ?? '')).toUpperCase();
}

export const CHANNEL_LABEL: Record<ChannelType, string> = {
  web_chat: 'Website chat',
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
};

/** A message of only "." pauses or resumes the AI instead of being sent. */
export function isDotCommand(text: string): boolean {
  return text.trim() === '.';
}

export function newClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `c${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** "now", "5m", "3h", "Mon", "12 Oct" for list rows. */
export function shortTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const mins = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60 && at.getDate() === now.getDate()) return `${Math.floor(mins / 60)}h`;
  if (mins < 6 * 24 * 60) return at.toLocaleDateString('en-GB', { weekday: 'short' });
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The embed code a merchant pastes into their site. */
export function embedSnippet(origin: string, publicKey: string): string {
  return `<script src="${origin}/widget.js" data-key="${publicKey}" async></script>`;
}
