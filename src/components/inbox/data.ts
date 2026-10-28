'use client';

import {
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, refreshSession } from '@/lib/api/client';
import type { Channel, Conversation, InboxMessage, Page, TeamMember } from '@/lib/api/types';
import { addMessage, inView, placeConversation, type InboxView } from '@/lib/inbox';

export const inboxKeys = {
  all: (orgId: string) => ['org', orgId, 'inbox'] as const,
  lists: (orgId: string) => ['org', orgId, 'inbox', 'list'] as const,
  list: (orgId: string, view: InboxView, q: string) =>
    ['org', orgId, 'inbox', 'list', view, q] as const,
  conversation: (orgId: string, id: string) => ['org', orgId, 'inbox', 'conversation', id] as const,
  messages: (orgId: string, id: string) => ['org', orgId, 'inbox', 'messages', id] as const,
  team: (orgId: string) => ['org', orgId, 'inbox', 'team'] as const,
  channels: (orgId: string) => ['org', orgId, 'inbox', 'channels'] as const,
};

export type ListData = InfiniteData<Page<Conversation>, string | undefined>;
export type MessagesData = InfiniteData<Page<InboxMessage>, string | undefined>;

export function useTeam(orgId: string) {
  return useQuery({
    queryKey: inboxKeys.team(orgId),
    queryFn: () => api<{ items: TeamMember[] }>(`/orgs/${orgId}/inbox/team`),
    staleTime: 5 * 60_000,
    select: (d) => d.items,
  });
}

export function useChannels(orgId: string, enabled = true) {
  return useQuery({
    queryKey: inboxKeys.channels(orgId),
    queryFn: () => api<{ items: Channel[] }>(`/orgs/${orgId}/channels`),
    select: (d) => d.items,
    staleTime: 60_000,
    enabled,
  });
}

/** Writes a changed conversation into every cached list and its own cache. */
export function applyConversation(qc: QueryClient, orgId: string, meId: string, c: Conversation) {
  qc.setQueryData(inboxKeys.conversation(orgId, c.id), c);
  for (const [key, data] of qc.getQueriesData<ListData>({ queryKey: inboxKeys.lists(orgId) })) {
    if (!data || data.pages.length === 0) continue;
    const view = key[4] as InboxView;
    const q = key[5] as string;
    if (q) {
      // Search results depend on the server's matching; ask again.
      void qc.invalidateQueries({ queryKey: key, exact: true });
      continue;
    }
    const items = data.pages.flatMap((p) => p.items);
    const nextCursor = data.pages.at(-1)!.nextCursor;
    let belongs = inView(c, view, meId);
    // Older than everything loaded while more pages exist: it will come with those pages.
    const oldest = items.at(-1);
    if (
      belongs &&
      nextCursor &&
      oldest &&
      !items.some((x) => x.id === c.id) &&
      Date.parse(c.lastMessageAt) < Date.parse(oldest.lastMessageAt)
    )
      belongs = false;
    qc.setQueryData<ListData>(key, {
      pages: [{ items: placeConversation(items, c, belongs), nextCursor }],
      pageParams: [data.pageParams[0]],
    });
  }
}

/** Adds a message to its thread's cache, when that thread is loaded. */
export function applyMessage(qc: QueryClient, orgId: string, m: InboxMessage) {
  qc.setQueryData<MessagesData>(inboxKeys.messages(orgId, m.conversationId), (data) => {
    if (!data || data.pages.length === 0) return data;
    const [first, ...rest] = data.pages;
    return { ...data, pages: [{ ...first!, items: addMessage(first!.items, m) }, ...rest] };
  });
}

export type LiveStatus = 'connecting' | 'live' | 'offline' | 'denied';

/** Who is typing in a conversation, and when the last signal came. */
export interface TypingSignal {
  who: 'contact' | 'ai';
  at: number;
}

interface InboxLive {
  status: LiveStatus;
  /** conversationId → the customer or the AI agent typing there. */
  typing: Record<string, TypingSignal>;
  sendTyping: (conversationId: string) => void;
}

const LiveContext = createContext<InboxLive>({
  status: 'offline',
  typing: {},
  sendTyping: () => undefined,
});

export const InboxLiveProvider = LiveContext.Provider;
export const useInboxLive = () => useContext(LiveContext);

/**
 * Keeps the inbox caches current over Socket.IO. On every (re)connect it joins the business
 * and refetches, so nothing missed while offline stays missing.
 */
export function useInboxConnection(orgId: string, meId: string): InboxLive {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [typing, setTyping] = useState<Record<string, TypingSignal>>({});
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io('/agents', {
      path: '/socket.io',
      addTrailingSlash: false,
      withCredentials: true,
    });
    socketRef.current = socket;
    let connectedOnce = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    socket.on('connect', () => {
      void socket
        .timeout(10_000)
        .emitWithAck('join', { orgId })
        .then((ack: { ok: boolean; code?: string }) => {
          if (!ack.ok) {
            setStatus('denied');
            return;
          }
          setStatus('live');
          if (connectedOnce) void qc.invalidateQueries({ queryKey: inboxKeys.all(orgId) });
          connectedOnce = true;
        })
        .catch(() => setStatus('offline'));
    });
    socket.on('disconnect', () => setStatus('offline'));
    socket.on('connect_error', (err: Error) => {
      setStatus('offline');
      // The server refused the handshake: the client does not retry on its own.
      if (socket.active) return;
      const auth = err.message === 'unauthorized' || err.message === 'session_revoked';
      retry = setTimeout(
        () => {
          void (auth ? refreshSession() : Promise.resolve(true)).then((ok) => {
            if (ok) socket.connect();
          });
        },
        auth ? 200 : 5_000,
      );
    });
    socket.on('revoked', () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
    });
    socket.on('conversation.updated', (c: Conversation) => applyConversation(qc, orgId, meId, c));
    socket.on('message.created', (m: InboxMessage) => {
      applyMessage(qc, orgId, m);
      // The customer's message ends their typing; the AI's reply (or handover) ends the AI's.
      const ends = m.direction === 'in' ? 'contact' : m.sender.type === 'ai' ? 'ai' : null;
      if (ends)
        setTyping((t) => {
          if (t[m.conversationId]?.who !== ends) return t;
          const { [m.conversationId]: _, ...rest } = t;
          return rest;
        });
    });
    socket.on('message.updated', (m: InboxMessage) => applyMessage(qc, orgId, m));
    socket.on('typing', (d: { conversationId: string; who: string }) => {
      const who = d.who === 'contact' || d.who === 'ai' ? d.who : null;
      if (who) setTyping((t) => ({ ...t, [d.conversationId]: { who, at: Date.now() } }));
    });

    return () => {
      if (retry) clearTimeout(retry);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [orgId, meId, qc]);

  // "typing…" fades after a few seconds without a new signal.
  useEffect(() => {
    if (Object.keys(typing).length === 0) return;
    const timer = setInterval(() => {
      setTyping((t) => {
        const now = Date.now();
        const kept = Object.fromEntries(
          Object.entries(t).filter(([, signal]) => now - signal.at < 5_000),
        );
        return Object.keys(kept).length === Object.keys(t).length ? t : kept;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [typing]);

  return {
    status,
    typing,
    sendTyping: (conversationId: string) => socketRef.current?.emit('typing', { conversationId }),
  };
}
