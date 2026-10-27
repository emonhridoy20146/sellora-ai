'use client';

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { useState } from 'react';
import { TIER_LABEL } from '@/components/billing/labels';
import { UsageChart } from '@/components/billing/usage-chart';
import { useOrg } from '@/components/org-context';
import { StatusBadge } from '@/components/status-badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { LoadMore } from '@/components/ui/load-more';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import type { Page, UsageRequest, UsageSummary } from '@/lib/api/types';
import { formatDateTime, formatMoney, formatNumber, humanize } from '@/lib/format';
import { rangeFromDays } from '@/lib/series';
import { cn } from '@/lib/utils';

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const;

export default function UsagePage() {
  const { org } = useOrg();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const summary = useQuery({
    queryKey: ['org', org.id, 'billing', 'usage', Number(days)],
    queryFn: () =>
      api<UsageSummary>(`/orgs/${org.id}/billing/ai-usage`, { query: rangeFromDays(Number(days)) }),
    placeholderData: keepPreviousData,
  });
  const requests = useInfiniteQuery({
    queryKey: ['org', org.id, 'billing', 'usage-requests'],
    queryFn: ({ pageParam }) =>
      api<Page<UsageRequest>>(`/orgs/${org.id}/billing/ai-usage/requests`, {
        query: { limit: 20, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const currency = org.currency;
  const s = summary.data;
  const items = requests.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="grid gap-6">
      <div className="flex justify-start">
        <Segmented label="Period" value={days} onChange={setDays} options={[...RANGES]} />
      </div>
      {summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : !s ? (
        <Skeleton className="h-80" />
      ) : (
        <div
          className={cn('grid gap-6 transition-opacity', summary.isPlaceholderData && 'opacity-60')}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Credits used" value={formatNumber(s.totals.credits, { digits: 0 })} />
            <Stat
              label="Charged"
              value={formatMoney(s.totals.chargedMinor, currency)}
              sub="Free credit counts as charged"
            />
            <Stat label="AI requests" value={formatNumber(s.totals.requests)} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Credits per day</CardTitle>
              <CardDescription>
                Days follow {org.timezone.replaceAll('_', ' ')} time.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {s.totals.requests === 0 ? (
                <EmptyState icon={Bot} title="No AI usage in this period" />
              ) : (
                <UsageChart summary={s} timeZone={org.timezone} />
              )}
            </CardContent>
          </Card>
          {s.byFeature.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>By feature</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <Table>
                  <THead>
                    <TR>
                      <TH>Feature</TH>
                      <TH className="text-right">Requests</TH>
                      <TH className="text-right">Credits</TH>
                      <TH className="text-right">Charged</TH>
                      <TH className="text-right">Share</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {[...s.byFeature]
                      .sort((a, b) => b.credits - a.credits)
                      .map((f) => (
                        <TR key={f.feature}>
                          <TD className="font-medium">{humanize(f.feature)}</TD>
                          <TD className="tabular text-right">{formatNumber(f.requests)}</TD>
                          <TD className="tabular text-right">{formatNumber(f.credits)}</TD>
                          <TD className="tabular text-right">
                            {formatMoney(f.chargedMinor, currency)}
                          </TD>
                          <TD className="tabular text-right text-muted-foreground">
                            {s.totals.credits > 0
                              ? `${((f.credits / s.totals.credits) * 100).toFixed(0)}%`
                              : '–'}
                          </TD>
                        </TR>
                      ))}
                  </TBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Every AI request</CardTitle>
          <CardDescription>
            Newest first. Tokens are the pieces of text the AI read and wrote.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {requests.isPending ? (
            <Skeleton className="m-5 h-40" />
          ) : requests.isError ? (
            <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={Bot} title="No AI requests yet" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Feature</TH>
                  <TH>Level</TH>
                  <TH className="text-right">Read / written</TH>
                  <TH className="text-right">Credits</TH>
                  <TH className="text-right">Charged</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((r) => (
                  <TR key={r.id}>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(r.at, org.timezone)}
                    </TD>
                    <TD>{humanize(r.feature)}</TD>
                    <TD>{TIER_LABEL[r.tier].name}</TD>
                    <TD className="tabular text-right text-muted-foreground">
                      {formatNumber(r.tokens.input)} / {formatNumber(r.tokens.output)}
                    </TD>
                    <TD className="tabular text-right">{formatNumber(r.credits)}</TD>
                    <TD className="tabular text-right">{formatMoney(r.chargedMinor, currency)}</TD>
                    <TD>
                      <StatusBadge status={r.status} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <LoadMore
            hasMore={Boolean(requests.hasNextPage)}
            loading={requests.isFetchingNextPage}
            onClick={() => void requests.fetchNextPage()}
          />
        </CardContent>
      </Card>
    </div>
  );
}
