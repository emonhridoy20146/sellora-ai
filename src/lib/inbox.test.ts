import { describe, expect, it } from 'vitest';
import type { Conversation, InboxMessage } from '@/lib/api/types';
import {
  addMessage,
  contactLabel,
  embedSnippet,
  inView,
  initials,
  isDotCommand,
  placeConversation,
  shortTime,
} from './inbox';

const conv = (id: string, at: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  channelId: 'ch',
  channelType: 'web_chat',
  status: 'open',
  assigneeId: null,
  ai: { mode: 'auto', changedAt: null, changedBy: null, reason: null },
  lastMessage: null,
  lastMessageAt: at,
  lastInboundAt: null,
  unread: 0,
  tags: [],
  locked: false,
  contact: null,
  createdAt: at,
  updatedAt: at,
  ...extra,
});

const msg = (id: string, clientId: string | null = null): InboxMessage => ({
  id,
  conversationId: 'c',
  direction: 'in',
  type: 'text',
  sender: { type: 'contact', id: null, name: null },
  text: id,
  attachments: [],
  clientId,
  delivery: { status: 'sent', error: null },
  ai: null,
  createdAt: '2026-10-27T10:00:00Z',
});

describe('inbox helpers', () => {
  it('places a changed conversation by its latest activity, or drops it', () => {
    const list = [conv('a', '2026-10-27T10:00:00Z'), conv('b', '2026-10-27T09:00:00Z')];
    const moved = placeConversation(list, conv('b', '2026-10-27T11:00:00Z'), true);
    expect(moved.map((c) => c.id)).toEqual(['b', 'a']);
    const added = placeConversation(list, conv('c', '2026-10-27T09:30:00Z'), true);
    expect(added.map((c) => c.id)).toEqual(['a', 'c', 'b']);
    expect(
      placeConversation(list, conv('a', '2026-10-27T12:00:00Z'), false).map((c) => c.id),
    ).toEqual(['b']);
  });

  it('knows which view a conversation belongs to', () => {
    const mine = conv('a', '2026-10-27T10:00:00Z', { assigneeId: 'me' });
    expect(inView(mine, 'mine', 'me')).toBe(true);
    expect(inView(mine, 'unassigned', 'me')).toBe(false);
    expect(inView({ ...mine, status: 'closed' }, 'open', 'me')).toBe(false);
    expect(inView({ ...mine, ai: { ...mine.ai, mode: 'paused' } }, 'paused', 'me')).toBe(true);
  });

  it('adds a message once, replacing the optimistic copy by clientId', () => {
    const list = [msg('tmp-1', 'abc')];
    expect(addMessage(list, msg('real-1', 'abc')).map((m) => m.id)).toEqual(['real-1']);
    expect(addMessage(list, msg('x')).map((m) => m.id)).toEqual(['x', 'tmp-1']);
    expect(addMessage([msg('x')], msg('x'))).toHaveLength(1);
  });

  it('labels contacts and makes initials', () => {
    expect(contactLabel(null)).toBe('Customer');
    expect(
      contactLabel({
        id: '1',
        channelId: 'c',
        name: '',
        phone: '+8801712345678',
        email: null,
        avatarUrl: null,
        customerId: null,
        lastSeenAt: null,
        createdAt: '',
      }),
    ).toBe('+8801712345678');
    expect(initials('Nusrat Jahan')).toBe('NJ');
    expect(initials('রহিম উদ্দিন')).toBe('রউ');
    expect(initials('+880')).toBe('8');
  });

  it('spots the dot command', () => {
    expect(isDotCommand(' . ')).toBe(true);
    expect(isDotCommand('..')).toBe(false);
    expect(isDotCommand('ok.')).toBe(false);
  });

  it('shows short times', () => {
    const now = new Date('2026-10-27T12:00:00');
    expect(shortTime('2026-10-27T11:59:40', now)).toBe('now');
    expect(shortTime('2026-10-27T11:15:00', now)).toBe('45m');
    expect(shortTime('2026-10-27T08:00:00', now)).toBe('4h');
    expect(shortTime('2026-10-01T08:00:00', now)).toBe('1 Oct');
  });

  it('builds the embed code', () => {
    expect(embedSnippet('https://app.sellora.ai', 'wc_abc')).toBe(
      '<script src="https://app.sellora.ai/widget.js" data-key="wc_abc" async></script>',
    );
  });
});
