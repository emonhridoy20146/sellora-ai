'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Stat } from '@/components/ui/stat';
import { salesPerAiSpend, share, timeSaved } from '@/lib/analytics';
import { api } from '@/lib/api/client';
import type { AnalyticsOverview } from '@/lib/api/types';
import { formatMoney, formatNumber } from '@/lib/format';
import { rangeFromDays } from '@/lib/series';

export function useAnalytics(orgId: string, days: number, enabled = true) {
  return useQuery({
    queryKey: ['org', orgId, 'analytics', days],
    queryFn: () =>
      api<AnalyticsOverview>(`/orgs/${orgId}/analytics/overview`, {
        query: rangeFromDays(days),
      }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** The value dashboard: what Sellora's automation did in the period. */
export function ValueTiles({ o, compact = false }: { o: AnalyticsOverview; compact?: boolean }) {
  const money = (minor: number) => formatMoney(minor, o.range.currency);
  const { ai, carts, riskyOrders } = o.value;
  const perTaka = ai?.orders ? salesPerAiSpend(ai.orders.valueMinor, ai.spentMinor) : null;
  const tiles: React.ReactNode[] = [];
  if (ai) {
    tiles.push(
      <Stat
        key="time"
        label="Time saved"
        value={timeSaved(ai.minutesSaved)}
        sub={`${formatNumber(ai.replies)} AI replies × ${ai.minutesPerReply} min each (an estimate)`}
      />,
      <Stat
        key="alone"
        label="Chats the AI handled alone"
        value={formatNumber(ai.answeredByAiOnly)}
        sub={
          ai.conversations
            ? `Of ${formatNumber(ai.conversations)} chats it answered (${share(ai.answeredByAiOnly, ai.conversations)}%); no one from your team was needed`
            : 'No chats answered by the AI yet'
        }
      />,
    );
    if (ai.orders)
      tiles.push(
        <Stat
          key="orders"
          label="Orders taken by the AI"
          value={formatNumber(ai.orders.count)}
          sub={
            ai.orders.count
              ? `${money(ai.orders.valueMinor)} in sales, not counting cancelled orders`
              : 'None in this period yet'
          }
        />,
      );
    if (!compact)
      tiles.push(
        <Stat
          key="cost"
          label="AI cost"
          value={money(ai.spentMinor)}
          sub={
            perTaka !== null
              ? `AI orders were worth ${formatNumber(perTaka)} times this`
              : 'AI credits used in this period'
          }
        />,
      );
    if (!compact && ai.voiceNotes > 0)
      tiles.push(
        <Stat
          key="voice"
          label="Voice notes understood"
          value={formatNumber(ai.voiceNotes)}
          sub="Turned into text and answered"
        />,
      );
  }
  if (carts)
    tiles.push(
      <Stat
        key="carts"
        label="Carts won back"
        value={formatNumber(carts.count)}
        sub={`${money(carts.valueMinor)} ordered after a reminder`}
      />,
    );
  if (riskyOrders)
    tiles.push(
      <Stat
        key="risky"
        label="Risky orders not sent"
        value={formatNumber(riskyOrders.stopped)}
        sub={
          riskyOrders.stopped
            ? `Cancelled before shipping; about ${money(riskyOrders.deliveryChargeMinor)} in delivery charges not wasted`
            : 'Cancelled orders from numbers the fraud check rates high risk'
        }
      />,
    );
  if (!tiles.length) return null;
  // The overview keeps one row of the four headline tiles; cost and voice notes stay here.
  if (compact) tiles.splice(4);
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{tiles}</div>;
}
