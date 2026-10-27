'use client';

import { Inbox, MessagesSquare, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { ContactPanel } from '@/components/inbox/contact-panel';
import { ConversationList } from '@/components/inbox/conversation-list';
import {
  InboxLiveProvider,
  useChannels,
  useInboxConnection,
  type LiveStatus,
} from '@/components/inbox/data';
import { Thread } from '@/components/inbox/thread';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { useDebounced } from '@/hooks/use-debounced';
import { useMe } from '@/lib/api/queries';
import { INBOX_VIEWS, type InboxView } from '@/lib/inbox';
import { cn } from '@/lib/utils';

const STATUS_TEXT: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  offline: 'Reconnecting…',
  denied: 'Live updates unavailable',
};

function LiveDot({ status }: { status: LiveStatus }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full',
          status === 'live' ? 'bg-success' : status === 'denied' ? 'bg-destructive' : 'bg-warning',
        )}
      />
      {STATUS_TEXT[status]}
    </span>
  );
}

function InboxScreen({ meId }: { meId: string }) {
  const { org, can, modules } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const live = useInboxConnection(org.id, meId);
  const canSeeAll = can('inbox.view');
  const [view, setView] = useState<InboxView>(() => {
    const v = params.get('view');
    return INBOX_VIEWS.find((x) => x.value === v && (canSeeAll || !x.needsAll))?.value ?? 'open';
  });
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const selectedId = params.get('c');
  const [details, setDetails] = useState(false);
  const channels = useChannels(org.id);

  const select = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set('c', id);
      else next.delete('c');
      router.replace(`/app/${org.id}/inbox${next.size ? `?${next}` : ''}`, { scroll: false });
    },
    [params, router, org.id],
  );

  const perms = {
    reply: can('inbox.reply'),
    assign: can('inbox.assign'),
    aiControl: can('inbox.ai_control'),
    aiInPlan: modules?.includes('ai_agent') ?? false,
  };
  const noChannels = channels.data?.length === 0;

  return (
    <InboxLiveProvider value={live}>
      <div className="flex h-full min-h-0">
        <section
          aria-label="Conversation list"
          className={cn(
            'flex w-full min-w-0 flex-col border-r lg:w-80 lg:shrink-0',
            selectedId && 'hidden lg:flex',
          )}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h1 className="text-base font-semibold">Inbox</h1>
            <div className="flex items-center gap-2">
              <LiveDot status={live.status} />
              {can('org.integrations.manage') && (
                <Button variant="ghost" size="icon-sm" asChild>
                  <Link href={`/app/${org.id}/settings/channels`} aria-label="Channels">
                    <Settings2 />
                  </Link>
                </Button>
              )}
            </div>
          </div>
          {noChannels && (
            <div className="border-b bg-info-soft px-3 py-2 text-[13px]">
              No channels yet.{' '}
              {can('org.integrations.manage') ? (
                <Link href={`/app/${org.id}/settings/channels`} className="font-medium underline">
                  Add the website chat
                </Link>
              ) : (
                'Ask an admin to connect one.'
              )}
            </div>
          )}
          <ConversationList
            orgId={org.id}
            view={view}
            onView={setView}
            search={search}
            onSearch={setSearch}
            q={q}
            selectedId={selectedId}
            onSelect={select}
            canSeeAll={canSeeAll}
          />
        </section>

        <section
          aria-label="Conversation"
          className={cn('min-w-0 flex-1 flex-col', selectedId ? 'flex' : 'hidden lg:flex')}
        >
          {selectedId ? (
            <Thread
              key={selectedId}
              orgId={org.id}
              meId={meId}
              conversationId={selectedId}
              perms={perms}
              onBack={() => select(null)}
              onShowDetails={() => setDetails(true)}
            />
          ) : (
            <EmptyState icon={MessagesSquare} title="Pick a conversation" className="m-auto">
              Messages from your website chat arrive here the moment customers write.
            </EmptyState>
          )}
        </section>

        {selectedId && (
          <aside
            aria-label="Customer details"
            className="hidden w-72 shrink-0 overflow-y-auto border-l xl:block"
          >
            <ContactPanel
              orgId={org.id}
              meId={meId}
              conversationId={selectedId}
              canEdit={perms.reply}
              aiInPlan={perms.aiInPlan}
            />
          </aside>
        )}
        {selectedId && (
          <Dialog open={details} onOpenChange={setDetails}>
            <DialogContent title="Customer details" className="xl:hidden">
              <ContactPanel
                orgId={org.id}
                meId={meId}
                conversationId={selectedId}
                canEdit={perms.reply}
                aiInPlan={perms.aiInPlan}
              />
            </DialogContent>
          </Dialog>
        )}
      </div>
    </InboxLiveProvider>
  );
}

export default function InboxPage() {
  const { org, can, modules } = useOrg();
  const me = useMe();
  if (!can('inbox.view') && !can('inbox.view_assigned'))
    return (
      <div className="p-6">
        <EmptyState icon={Inbox} title="Your role does not include the inbox">
          Ask the business owner to give your role inbox access.
        </EmptyState>
      </div>
    );
  if (modules && !modules.includes('inbox'))
    return (
      <div className="p-6">
        <EmptyState
          icon={Inbox}
          title="The inbox is not in your plan"
          action={
            can('billing.view') && (
              <Button asChild>
                <Link href={`/app/${org.id}/billing/plans`}>See plans</Link>
              </Button>
            )
          }
        >
          Upgrade to answer website chats, Messenger, Instagram and WhatsApp in one place.
        </EmptyState>
      </div>
    );
  if (!me.data) return null;
  return <InboxScreen meId={me.data.user.id} />;
}
