'use client';

import { useState } from 'react';
import {
  AlertsCard,
  BotCard,
  ChatsCard,
  MessagesCard,
  ReportsCard,
  useTelegram,
} from '@/components/telegram/admin';
import { usePlatform } from '@/components/platform-context';
import { ErrorState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Admin › Telegram (ADR 0022): the bot, the chats that get owner reports and alerts and what
 * each gets, report times, alert thresholds, and what the bot sent lately.
 */
export default function PlatformTelegramPage() {
  const { can } = usePlatform();
  const allowed = can('platform.telegram.manage');
  const [linking, setLinking] = useState(false);
  const q = useTelegram(linking);

  return (
    <>
      <PageHeader
        title="Telegram"
        description="Daily, weekly and monthly reports and instant alerts for the people who run Sellora, in Telegram chats you choose."
      />
      {!allowed ? (
        <ErrorState error={new Error('Your role cannot change Telegram reports.')} />
      ) : q.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="grid gap-6">
          <BotCard overview={q.data} />
          <ChatsCard overview={q.data} onLinking={setLinking} />
          <div className="grid gap-6 xl:grid-cols-2">
            <ReportsCard key={JSON.stringify(q.data.reports)} overview={q.data} />
            <AlertsCard key={JSON.stringify(q.data.alerts)} overview={q.data} />
          </div>
          <MessagesCard chats={q.data.chats} />
        </div>
      )}
    </>
  );
}
