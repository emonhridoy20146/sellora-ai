'use client';

import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Bot, Lock, Search } from 'lucide-react';
import { ChannelGlyph } from '@/components/channel-icons';
import { ErrorState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import type { ChannelType, Conversation, Page } from '@/lib/api/types';
import {
  INBOX_VIEWS,
  contactLabel,
  initials,
  shortTime,
  viewQuery,
  type InboxView,
} from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { inboxKeys, useInboxLive } from './data';

export function ChannelIcon({ type, className }: { type: ChannelType; className?: string }) {
  return <ChannelGlyph type={type} label className={cn('size-3.5', className)} />;
}

export function Avatar({ label, className }: { label: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-9 shrink-0 place-content-center rounded-full bg-muted text-[13px] font-semibold text-muted-foreground',
        className,
      )}
    >
      {initials(label)}
    </span>
  );
}

function preview(c: Conversation): string {
  if (c.locked) return 'Over this month’s limit';
  const m = c.lastMessage;
  if (!m) return 'No messages yet';
  const who = m.direction === 'out' ? (m.senderType === 'ai' ? 'AI: ' : 'You: ') : '';
  return `${who}${m.text}`;
}

export function ConversationList({
  orgId,
  view,
  onView,
  search,
  onSearch,
  q,
  selectedId,
  onSelect,
  canSeeAll,
}: {
  orgId: string;
  view: InboxView;
  onView: (v: InboxView) => void;
  search: string;
  onSearch: (s: string) => void;
  q: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  canSeeAll: boolean;
}) {
  const { typing } = useInboxLive();
  const list = useInfiniteQuery({
    queryKey: inboxKeys.list(orgId, view, q),
    queryFn: ({ pageParam }) =>
      api<Page<Conversation>>(`/orgs/${orgId}/conversations`, {
        query: { ...viewQuery(view), q, limit: 30, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b p-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <label htmlFor="inbox-search" className="sr-only">
            Search conversations
          </label>
          <Input
            id="inbox-search"
            type="search"
            placeholder="Name, phone or email"
            className="pl-8"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
        <nav aria-label="Conversation views" className="-mx-1 flex flex-wrap gap-1">
          {INBOX_VIEWS.filter((v) => canSeeAll || !v.needsAll).map((v) => (
            <button
              key={v.value}
              type="button"
              aria-current={view === v.value ? 'page' : undefined}
              onClick={() => onView(v.value)}
              className={cn(
                'shrink-0 rounded-full px-2.5 py-1 text-[13px] font-medium transition-colors',
                view === v.value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {v.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <div className="space-y-1 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : list.isError ? (
          <div className="p-4">
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {q
              ? 'No conversations match.'
              : view === 'closed'
                ? 'No closed conversations.'
                : 'No conversations here yet. New chats appear the moment a customer writes.'}
          </p>
        ) : (
          <ul aria-label="Conversations">
            {items.map((c) => {
              const label = contactLabel(c.contact, c.channelType);
              const typingWho = typing[c.id]?.who;
              const isTyping = Boolean(typingWho);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    aria-current={selectedId === c.id ? 'true' : undefined}
                    className={cn(
                      'flex w-full gap-3 border-b px-3 py-2.5 text-left transition-colors hover:bg-accent/60',
                      selectedId === c.id && 'bg-accent',
                    )}
                  >
                    <Avatar label={label} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-sm',
                            c.unread > 0 ? 'font-semibold' : 'font-medium',
                          )}
                        >
                          {label}
                        </span>
                        <time
                          dateTime={c.lastMessageAt}
                          className="shrink-0 text-xs text-muted-foreground"
                        >
                          {shortTime(c.lastMessageAt)}
                        </time>
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                        <ChannelIcon type={c.channelType} className="shrink-0" />
                        {c.locked && <Lock className="size-3.5 shrink-0" aria-hidden />}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate',
                            c.unread > 0 && 'text-foreground',
                            isTyping && 'text-primary italic',
                          )}
                        >
                          {isTyping
                            ? typingWho === 'ai'
                              ? 'AI is replying…'
                              : 'typing…'
                            : preview(c)}
                        </span>
                        {c.ai.mode === 'paused' && (
                          <Bot className="size-3.5 shrink-0" aria-label="AI paused" />
                        )}
                        {c.unread > 0 && (
                          <span className="grid min-w-5 shrink-0 place-content-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                            <span className="sr-only">Unread: </span>
                            {c.unread > 99 ? '99+' : c.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <LoadMore
          hasMore={Boolean(list.hasNextPage)}
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        />
      </div>
    </div>
  );
}
