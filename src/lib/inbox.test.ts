import { describe, expect, it } from 'vitest';
import type { Conversation, InboxMessage } from '@/lib/api/types';
import {
  DELIVERY_LABEL,
  addMessage,
  aiPauseReason,
  contactLabel,
  durationLabel,
  embedSnippet,
  failedOnServer,
  inView,
  initials,
  isAiHandover,
  isDotCommand,
  placeConversation,
  replyWindow,
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
  replyWindowEndsAt: null,
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
    const contact = {
      id: '1',
      channelId: 'c',
      name: '',
      phone: '+8801712345678',
      email: null,
      avatarUrl: null,
      customerId: null,
      memory: { facts: [], address: null },
      lastSeenAt: null,
      createdAt: '',
    };
    expect(contactLabel(null)).toBe('Customer');
    expect(contactLabel(contact)).toBe('+8801712345678');
    expect(contactLabel({ ...contact, phone: null })).toBe('Website visitor');
    expect(contactLabel({ ...contact, phone: null }, 'messenger')).toBe('Messenger customer');
    expect(initials('Nusrat Jahan')).toBe('NJ');
    expect(initials('রহিম উদ্দিন')).toBe('রউ');
    expect(initials('+880')).toBe('8');
  });

  it('explains why the AI is paused', () => {
    expect(aiPauseReason('keyword')).toBe('The customer asked for a person');
    expect(aiPauseReason('no_credits')).toBe('AI credits ran out');
    expect(aiPauseReason('something_new')).toBe('AI paused');
    expect(aiPauseReason(null)).toBe('AI paused');
    expect(isAiHandover('ai_handover')).toBe(true);
    expect(isAiHandover('no_credits')).toBe(true);
    expect(isAiHandover('human_reply')).toBe(false);
    expect(isAiHandover('dot_command')).toBe(false);
    expect(isAiHandover(null)).toBe(false);
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

describe('Meta channels', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');

  it('reads the 24-hour reply window', () => {
    expect(replyWindow({ replyWindowEndsAt: null }, now)).toEqual({ open: true, msLeft: null });
    expect(replyWindow({ replyWindowEndsAt: '2026-10-28T14:30:00Z' }, now)).toEqual({
      open: true,
      msLeft: 2.5 * 3600_000,
    });
    expect(replyWindow({ replyWindowEndsAt: '2026-10-28T11:00:00Z' }, now)).toEqual({
      open: false,
      msLeft: 0,
    });
  });

  it('writes time left briefly', () => {
    expect(durationLabel(30_000)).toBe('under a minute');
    expect(durationLabel(45 * 60_000)).toBe('45m');
    expect(durationLabel(3 * 3600_000)).toBe('3h');
    expect(durationLabel(23 * 3600_000 + 10 * 60_000)).toBe('23h 10m');
  });

  it('tells a message Meta refused from one that never reached the server', () => {
    expect(failedOnServer({ id: 'abc', delivery: { status: 'failed', error: 'x' } })).toBe(true);
    expect(failedOnServer({ id: 'tmp-c1', delivery: { status: 'failed', error: 'x' } })).toBe(
      false,
    );
    expect(failedOnServer({ id: 'abc', delivery: { status: 'sent', error: null } })).toBe(false);
    expect(DELIVERY_LABEL.read).toBe('Seen');
  });

  it('treats a reply from the Facebook app as a person answering, not a handover', () => {
    expect(aiPauseReason('replied_elsewhere')).toBe('Someone replied from outside Sellora');
    expect(isAiHandover('replied_elsewhere')).toBe(false);
  });
});
