'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clock,
  Lock,
  RotateCcw,
  RotateCw,
  Send,
  StickyNote,
  UserRound,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ErrorState } from '@/components/ui/empty-state';
import { Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Conversation, InboxMessage, Page, TeamMember } from '@/lib/api/types';
import { formatCredits, formatDateTime, formatRelative } from '@/lib/format';
import {
  CHANNEL_LABEL,
  DELIVERY_LABEL,
  addMessage,
  aiPauseReason,
  contactLabel,
  durationLabel,
  failedOnServer,
  isAiHandover,
  isDotCommand,
  newClientId,
  replyWindow,
} from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { Avatar, ChannelIcon } from './conversation-list';
import { MessageAttachmentView } from './message-attachment';
import {
  applyConversation,
  applyMessage,
  inboxKeys,
  useChannels,
  useInboxLive,
  useTeam,
  type MessagesData,
} from './data';

/** Shows Meta's reply window closing soon when this little time is left. */
const WINDOW_WARN_MS = 3 * 3600_000;

/** The current time, refreshed every minute while `active`. */
function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

interface Perms {
  reply: boolean;
  assign: boolean;
  aiControl: boolean;
  /** The plan includes the AI agent. */
  aiInPlan: boolean;
}

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function MessageRow({
  m,
  social,
  onRetry,
  onDiscard,
  onRetryTranscript,
  retryingTranscript,
}: {
  m: InboxMessage;
  /** Messenger, Instagram or WhatsApp: Meta reports delivery and reads. */
  social: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
  /** Voice notes: ask speech-to-text again for attachment `index`. */
  onRetryTranscript?: ((index: number) => void) | undefined;
  /** The attachment index being retried right now. */
  retryingTranscript?: number | null;
}) {
  if (m.type === 'system')
    return (
      <li className="my-2 text-center text-xs text-muted-foreground">
        {m.text} · {timeOf(m.createdAt)}
      </li>
    );
  if (m.type === 'note')
    return (
      <li className="my-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm">
        <p className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-warning">
          <StickyNote className="size-3.5" aria-hidden /> Note by {m.sender.name ?? 'staff'} ·{' '}
          {timeOf(m.createdAt)}
        </p>
        <p className="break-words whitespace-pre-wrap">{m.text}</p>
      </li>
    );
  const mine = m.direction === 'out';
  const pending = m.delivery.status === 'pending';
  const failed = m.delivery.status === 'failed';
  return (
    <li className={cn('my-1.5 flex flex-col', mine ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm break-words whitespace-pre-wrap',
          mine
            ? m.sender.type === 'ai'
              ? 'rounded-br-md bg-info-soft text-foreground'
              : 'rounded-br-md bg-primary text-primary-foreground'
            : 'rounded-bl-md bg-muted',
          pending && 'opacity-60',
          failed && 'ring-2 ring-destructive',
        )}
      >
        {m.attachments.length > 0 && (
          <div className={cn('flex flex-wrap gap-1.5', m.text && 'mb-1.5')}>
            {m.attachments.map((a, i) => (
              <MessageAttachmentView
                key={a.url ?? `${m.id}-${i}`}
                a={a}
                {...(onRetryTranscript && a.kind === 'audio'
                  ? {
                      onRetryTranscript: () => onRetryTranscript(i),
                      retrying: retryingTranscript === i,
                    }
                  : {})}
              />
            ))}
          </div>
        )}
        {m.text}
      </div>
      <span className="mt-0.5 flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
        {mine && m.sender.type === 'ai' && <Bot className="size-3" aria-hidden />}
        {mine && (m.sender.type === 'ai' ? 'AI' : (m.sender.name ?? 'You'))}
        {mine && m.sender.type === 'ai' && m.ai && ` · ${formatCredits(m.ai.credits)}`}
        {mine && ' · '}
        {pending ? 'Sending…' : timeOf(m.createdAt)}
        {mine && social && !pending && !failed && m.delivery.status !== 'sent' && (
          <span className={m.delivery.status === 'read' ? 'text-primary' : undefined}>
            {' · '}
            {DELIVERY_LABEL[m.delivery.status]}
          </span>
        )}
      </span>
      {failed && (
        <span className="mt-0.5 flex items-center gap-2 text-[12px] text-destructive">
          <AlertTriangle className="size-3.5" aria-hidden /> {m.delivery.error ?? 'Not sent'}
          {onRetry && (
            <button type="button" className="font-medium underline" onClick={onRetry}>
              Retry
            </button>
          )}
          {onDiscard && (
            <button type="button" className="font-medium underline" onClick={onDiscard}>
              Remove
            </button>
          )}
        </span>
      )}
    </li>
  );
}

function LockedNotice({ orgId, error }: { orgId: string; error: ApiError }) {
  const max = error.details.max;
  return (
    <div className="mx-auto mt-10 max-w-sm rounded-lg border bg-card p-5 text-center text-sm">
      <Lock className="mx-auto mb-2 size-6 text-muted-foreground" aria-hidden />
      <p className="font-medium">This conversation is over your plan’s monthly limit</p>
      <p className="mt-1 text-muted-foreground">
        Your plan includes {typeof max === 'number' ? max : 'a set number of'} conversations a
        month. The customer’s messages are saved. Upgrade to read and answer them now.
      </p>
      <Button asChild className="mt-4">
        <Link href={`/app/${orgId}/billing/plans`}>See plans</Link>
      </Button>
    </div>
  );
}

export function Thread({
  orgId,
  meId,
  conversationId,
  perms,
  onBack,
  onShowDetails,
}: {
  orgId: string;
  meId: string;
  conversationId: string;
  perms: Perms;
  onBack: () => void;
  onShowDetails?: () => void;
}) {
  const qc = useQueryClient();
  const live = useInboxLive();
  const team = useTeam(orgId);
  const { can } = useOrg();
  const channels = useChannels(orgId);
  const conv = useQuery({
    queryKey: inboxKeys.conversation(orgId, conversationId),
    queryFn: () => api<Conversation>(`/orgs/${orgId}/conversations/${conversationId}`),
  });
  const messages = useInfiniteQuery({
    queryKey: inboxKeys.messages(orgId, conversationId),
    queryFn: ({ pageParam }) =>
      api<Page<InboxMessage>>(`/orgs/${orgId}/conversations/${conversationId}/messages`, {
        query: { limit: 50, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const c = conv.data;
  const ordered = [...(messages.data?.pages.flatMap((p) => p.items) ?? [])].reverse();

  const updateConversation = (next: Conversation) => applyConversation(qc, orgId, meId, next);
  const post = (path: string, body?: unknown) =>
    api<Conversation>(`/orgs/${orgId}/conversations/${conversationId}/${path}`, {
      method: 'POST',
      body: body ?? {},
    });

  // Opening a thread with unread messages marks it read.
  const unread = c?.unread ?? 0;
  const locked = c?.locked ?? false;
  useEffect(() => {
    if (unread === 0 || locked || document.visibilityState !== 'visible') return;
    void post('read')
      .then(updateConversation)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when these change
  }, [conversationId, unread, locked]);

  // Stay at the bottom as messages arrive, unless the reader scrolled up.
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastId = ordered.at(-1)?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastId, conversationId]);

  const setAi = useMutation({
    mutationFn: (mode: 'auto' | 'paused') => post('ai', { mode }),
    onSuccess: (next) => {
      updateConversation(next);
      void qc.invalidateQueries({ queryKey: inboxKeys.messages(orgId, conversationId) });
    },
  });
  const assign = useMutation({
    mutationFn: (assigneeId: string | null) => post('assign', { assigneeId }),
    onSuccess: (next) => {
      updateConversation(next);
      void qc.invalidateQueries({ queryKey: inboxKeys.messages(orgId, conversationId) });
    },
  });
  const setStatus = useMutation({
    mutationFn: (status: 'open' | 'closed') => post('status', { status }),
    onSuccess: (next) => {
      updateConversation(next);
      toast.success(next.status === 'closed' ? 'Conversation closed' : 'Conversation reopened');
      void qc.invalidateQueries({ queryKey: inboxKeys.messages(orgId, conversationId) });
    },
  });

  // ---------------------------------------------------------------- composer
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const lastTyping = useRef(0);

  const patchMessage = (clientId: string, patch: Partial<InboxMessage>) =>
    qc.setQueryData<MessagesData>(inboxKeys.messages(orgId, conversationId), (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((p) => ({
              ...p,
              items: p.items.map((m) => (m.clientId === clientId ? { ...m, ...patch } : m)),
            })),
          }
        : data,
    );
  const dropMessage = (clientId: string) =>
    qc.setQueryData<MessagesData>(inboxKeys.messages(orgId, conversationId), (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((p) => ({
              ...p,
              items: p.items.filter((m) => m.clientId !== clientId),
            })),
          }
        : data,
    );

  // A message Meta refused, sent again from the server's copy.
  const resend = useMutation({
    mutationFn: (messageId: string) =>
      api<{ message: InboxMessage }>(
        `/orgs/${orgId}/conversations/${conversationId}/messages/${messageId}/retry`,
        { method: 'POST' },
      ),
    onSuccess: (res) => applyMessage(qc, orgId, res.message),
  });

  // A voice note sent to speech-to-text again; the words arrive live.
  const transcribe = useMutation({
    mutationFn: (v: { messageId: string; index: number }) =>
      api<{ message: InboxMessage }>(
        `/orgs/${orgId}/conversations/${conversationId}/messages/${v.messageId}/attachments/${v.index}/transcribe`,
        { method: 'POST' },
      ),
    onSuccess: (res) => applyMessage(qc, orgId, res.message),
  });

  const send = useMutation({
    meta: { silent: true },
    mutationFn: (v: { text: string; note: boolean; clientId: string }) =>
      api<{ message: InboxMessage | null; conversation: Conversation }>(
        `/orgs/${orgId}/conversations/${conversationId}/messages`,
        { method: 'POST', body: v },
      ),
    onMutate: (v) => {
      if (isDotCommand(v.text) && !v.note) return;
      const optimistic: InboxMessage = {
        id: `tmp-${v.clientId}`,
        conversationId,
        direction: 'out',
        type: v.note ? 'note' : 'text',
        sender: { type: 'user', id: meId, name: null },
        text: v.text,
        attachments: [],
        clientId: v.clientId,
        delivery: { status: 'pending', error: null },
        ai: null,
        createdAt: new Date().toISOString(),
      };
      atBottom.current = true;
      qc.setQueryData<MessagesData>(inboxKeys.messages(orgId, conversationId), (data) => {
        if (!data || data.pages.length === 0) return data;
        const [first, ...rest] = data.pages;
        return {
          ...data,
          pages: [{ ...first!, items: addMessage(first!.items, optimistic) }, ...rest],
        };
      });
    },
    onSuccess: (res, v) => {
      if (res.message) applyMessage(qc, orgId, res.message);
      updateConversation(res.conversation);
      if (!res.message) {
        toast.success(
          res.conversation.ai.mode === 'paused'
            ? 'AI paused in this conversation'
            : 'AI is answering this conversation again',
        );
        void qc.invalidateQueries({ queryKey: inboxKeys.messages(orgId, conversationId) });
      } else if (res.conversation.ai.reason === 'human_reply' && v.note === false) {
        void qc.invalidateQueries({ queryKey: inboxKeys.messages(orgId, conversationId) });
      }
    },
    onError: (err, v) => {
      if (isDotCommand(v.text) && !v.note) toast.error(errorMessage(err));
      else patchMessage(v.clientId, { delivery: { status: 'failed', error: errorMessage(err) } });
    },
  });

  const windowEndsAt = conv.data?.replyWindowEndsAt ?? null;
  const now = useMinuteClock(windowEndsAt !== null);
  const replyWin = replyWindow({ replyWindowEndsAt: windowEndsAt }, now);
  const channel = channels.data?.find((x) => x.id === conv.data?.channelId);
  const needsReconnect = channel?.status === 'error';
  const canReply = replyWin.open && !needsReconnect;
  const composing = canReply ? mode : 'note';

  const submit = () => {
    const value = text.trim();
    if (!value || !c) return;
    setText('');
    send.mutate({ text: value, note: composing === 'note', clientId: newClientId() });
  };

  if (conv.isPending)
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-16 w-1/2" />
      </div>
    );
  if (conv.isError || !c)
    return (
      <div className="p-4">
        <ErrorState error={conv.error} onRetry={() => void conv.refetch()} />
      </div>
    );

  const label = contactLabel(c.contact, c.channelType);
  const assignee = team.data?.find((m) => m.userId === c.assigneeId);
  const lockedError =
    messages.error instanceof ApiError && messages.error.status === 402 ? messages.error : null;
  const typing = live.typing[c.id]?.who ?? null;
  const showPaused = perms.aiInPlan && c.ai.mode === 'paused' && !c.locked;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          onClick={onBack}
          aria-label="Back to conversations"
        >
          <ArrowLeft />
        </Button>
        <Avatar label={label} className="size-8" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{label}</h2>
          <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <ChannelIcon type={c.channelType} /> {CHANNEL_LABEL[c.channelType]}
            {typing && (
              <span className="text-primary italic">
                {' · '}
                {typing === 'ai' ? 'AI is replying…' : 'typing…'}
              </span>
            )}
          </p>
        </div>

        {perms.aiInPlan && (
          <label
            className="hidden items-center gap-2 text-[13px] sm:flex"
            title={perms.aiControl ? 'Or send “.” to switch' : 'Your role cannot switch the AI'}
          >
            <Bot className="size-4 text-muted-foreground" aria-hidden />
            <span>AI</span>
            <Switch
              checked={c.ai.mode === 'auto'}
              disabled={!perms.aiControl || setAi.isPending || c.locked}
              onCheckedChange={(on) => setAi.mutate(on ? 'auto' : 'paused')}
              aria-label="AI replies in this conversation"
            />
          </label>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={!perms.assign && !onShowDetails}
              aria-label={`Assigned: ${c.assigneeId ? (assignee?.isYou ? 'you' : (assignee?.name ?? 'someone')) : 'nobody'}. More actions`}
            >
              <UserRound />
              <span className="hidden max-w-28 truncate sm:inline">
                {c.assigneeId
                  ? assignee?.isYou
                    ? 'You'
                    : (assignee?.name ?? 'Assigned')
                  : 'Unassigned'}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {perms.assign && (
              <>
                <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                {(team.data ?? []).map((m: TeamMember) => (
                  <DropdownMenuItem
                    key={m.userId}
                    onSelect={() => assign.mutate(m.userId)}
                    disabled={m.userId === c.assigneeId}
                  >
                    {m.name}
                    {m.isYou && ' (you)'}
                  </DropdownMenuItem>
                ))}
                {c.assigneeId && (
                  <DropdownMenuItem onSelect={() => assign.mutate(null)}>
                    <X /> Unassign
                  </DropdownMenuItem>
                )}
              </>
            )}
            {perms.aiInPlan && perms.aiControl && !c.locked && (
              <DropdownMenuItem
                className="sm:hidden"
                onSelect={() => setAi.mutate(c.ai.mode === 'auto' ? 'paused' : 'auto')}
              >
                <Bot /> {c.ai.mode === 'auto' ? 'Pause the AI' : 'Turn the AI back on'}
              </DropdownMenuItem>
            )}
            {onShowDetails && (
              <>
                {perms.assign && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={onShowDetails}>Customer details</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {perms.reply &&
          (c.status === 'open' ? (
            <Button
              variant="outline"
              size="sm"
              aria-label="Close"
              onClick={() => setStatus.mutate('closed')}
              loading={setStatus.isPending}
            >
              <CheckCircle2 /> <span className="hidden sm:inline">Close</span>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              aria-label="Reopen"
              onClick={() => setStatus.mutate('open')}
              loading={setStatus.isPending}
            >
              <RotateCcw /> <span className="hidden sm:inline">Reopen</span>
            </Button>
          ))}
      </header>

      {showPaused && (
        <div
          className={cn(
            'flex items-center gap-2 border-b px-4 py-1.5 text-[13px]',
            isAiHandover(c.ai.reason) ? 'bg-warning-soft' : 'bg-muted/60',
          )}
        >
          <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">AI paused</span>
            {' · '}
            {aiPauseReason(c.ai.reason)}
            {c.ai.changedAt && (
              <span className="text-muted-foreground"> · {formatRelative(c.ai.changedAt)}</span>
            )}
          </span>
          {perms.aiControl && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              loading={setAi.isPending}
              onClick={() => setAi.mutate('auto')}
            >
              Turn AI back on
            </Button>
          )}
        </div>
      )}

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {lockedError ? (
          <LockedNotice orgId={orgId} error={lockedError} />
        ) : messages.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-2/3" />
            <Skeleton className="ml-auto h-12 w-1/2" />
          </div>
        ) : messages.isError ? (
          <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
        ) : (
          <>
            {messages.hasNextPage && (
              <div className="mb-2 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={messages.isFetchingNextPage}
                  onClick={() => {
                    atBottom.current = false;
                    void messages.fetchNextPage();
                  }}
                >
                  Load earlier messages
                </Button>
              </div>
            )}
            <p className="mb-3 text-center text-xs text-muted-foreground">
              Started {formatDateTime(c.createdAt)}
            </p>
            <ol aria-label="Messages" aria-live="polite">
              {ordered.map((m) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  social={c.channelType !== 'web_chat'}
                  {...(perms.reply && !c.locked && m.attachments.some((a) => a.kind === 'audio')
                    ? {
                        onRetryTranscript: (index: number) =>
                          transcribe.mutate({ messageId: m.id, index }),
                        retryingTranscript:
                          transcribe.isPending && transcribe.variables.messageId === m.id
                            ? transcribe.variables.index
                            : null,
                      }
                    : {})}
                  {...(failedOnServer(m)
                    ? perms.reply && canReply
                      ? { onRetry: () => resend.mutate(m.id) }
                      : {}
                    : m.delivery.status === 'failed' && m.clientId
                      ? {
                          onRetry: () => {
                            patchMessage(m.clientId!, {
                              delivery: { status: 'pending', error: null },
                            });
                            send.mutate({
                              text: m.text,
                              note: m.type === 'note',
                              clientId: m.clientId!,
                            });
                          },
                          onDiscard: () => dropMessage(m.clientId!),
                        }
                      : {})}
                />
              ))}
            </ol>
          </>
        )}
      </div>

      {perms.reply && !lockedError && !canReply && (
        <div
          role="status"
          className="flex items-start gap-2 border-t bg-muted/60 px-4 py-2 text-[13px]"
        >
          {needsReconnect ? (
            <>
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <span>
                Meta stopped accepting messages from this {CHANNEL_LABEL[c.channelType]} channel, so
                replies cannot go out.{' '}
                {can('org.integrations.manage') ? (
                  <Link
                    href={`/app/${orgId}/settings/channels`}
                    className="font-medium text-primary hover:underline"
                  >
                    Reconnect it
                  </Link>
                ) : (
                  'Ask an admin to reconnect it in Settings › Channels.'
                )}{' '}
                Notes still work.
              </span>
            </>
          ) : (
            <>
              <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                More than 24 hours have passed since {label} last wrote. Meta allows replies only
                within 24 hours, so you can answer when they write again. Notes still work.
              </span>
            </>
          )}
        </div>
      )}
      {perms.reply && !lockedError && (
        <form
          className={cn('border-t p-3', composing === 'note' && 'bg-warning-soft/50')}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <Segmented
              label="Message type"
              value={composing}
              onChange={setMode}
              options={
                canReply
                  ? [
                      { value: 'reply', label: 'Reply' },
                      { value: 'note', label: 'Note' },
                    ]
                  : [{ value: 'note', label: 'Note' }]
              }
            />
            {canReply &&
            replyWin.msLeft !== null &&
            replyWin.msLeft < WINDOW_WARN_MS &&
            composing === 'reply' ? (
              <span className="flex items-center gap-1 text-xs text-warning">
                <Clock className="size-3.5" aria-hidden /> Reply window closes in{' '}
                {durationLabel(replyWin.msLeft)}
              </span>
            ) : (
              c.ai.mode === 'auto' &&
              perms.aiInPlan &&
              composing === 'reply' && (
                <span className="text-xs text-muted-foreground">Replying pauses the AI here</span>
              )
            )}
          </div>
          <div className="flex items-end gap-2">
            <label htmlFor="composer" className="sr-only">
              {composing === 'note' ? 'Internal note' : 'Reply'}
            </label>
            <Textarea
              id="composer"
              rows={2}
              value={text}
              maxLength={4000}
              placeholder={
                composing === 'note'
                  ? 'Only your team sees notes'
                  : `Reply to ${label}${perms.aiControl && perms.aiInPlan ? ' (send “.” to pause or resume the AI)' : ''}`
              }
              className="max-h-40 min-h-11 resize-none"
              onChange={(e) => {
                setText(e.target.value);
                const now = Date.now();
                if (composing === 'reply' && now - lastTyping.current > 2_000) {
                  lastTyping.current = now;
                  live.sendTyping(conversationId);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              aria-label={composing === 'note' ? 'Add note' : 'Send'}
              disabled={!text.trim()}
            >
              {send.isPending && isDotCommand(text) ? (
                <RotateCw className="animate-spin" />
              ) : (
                <Send />
              )}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Enter to send, Shift + Enter for a new line.
          </p>
        </form>
      )}
      {!perms.reply && (
        <p className="border-t p-3 text-center text-xs text-muted-foreground">
          Your role can read conversations but not reply.
        </p>
      )}
    </div>
  );
}
