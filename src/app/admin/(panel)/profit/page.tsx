'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { TrendingUp, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { TIER_LABEL } from '@/components/billing/labels';
import { ProfitChart } from '@/components/charts/profit-chart';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import type { ModelTier, ProfitReport, ProfitRow } from '@/lib/api/types';
import { formatMoney, formatNumber, formatPercent, humanize } from '@/lib/format';
import { longDay, rangeFromDays } from '@/lib/series';
import { cn } from '@/lib/utils';

type GroupBy = ProfitReport['groupBy'];
const RANGES = ['7', '30', '90'] as const;
const GROUPS: { value: GroupBy; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'org', label: 'Business' },
  { value: 'model', label: 'Model' },
  { value: 'feature', label: 'Feature' },
  { value: 'tier', label: 'Tier' },
];

export default function ProfitPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Profit />
    </Suspense>
  );
}

function Profit() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const orgId = params.get('orgId') ?? undefined;
  const [days, setDays] = useState<(typeof RANGES)[number]>('30');
  const [groupBy, setGroupBy] = useState<GroupBy>('day');
  // The range is fixed when the period changes, so refetches don't shift the window.
  const range = useMemo(() => rangeFromDays(Number(days)), [days]);
  const report = useQuery({
    queryKey: ['platform', 'profit', range.from, range.to, groupBy, orgId],
    queryFn: () =>
      api<ProfitReport>('/platform/billing/ai-profit', {
        query: { from: range.from, to: range.to, groupBy, orgId },
      }),
    placeholderData: keepPreviousData,
  });
  const orgName = useQuery({
    queryKey: ['platform', 'tenant', orgId],
    queryFn: () => api<{ name: string }>(`/platform/tenants/${orgId}`),
    enabled: Boolean(orgId),
  });

  const totals = useMemo(() => totalsByCurrency(report.data?.rows ?? []), [report.data]);

  return (
    <>
      <PageHeader
        title="AI revenue & profit"
        description="What businesses paid for AI credits against what the providers charged us."
        actions={
          <>
            <Segmented
              label="Period"
              value={days}
              onChange={setDays}
              options={RANGES.map((r) => ({ value: r, label: `${r} days` }))}
            />
          </>
        }
      />
      {orgId && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Only</span>
          <Badge tone="info" className="py-1">
            <Link href={`/admin/tenants/${orgId}`} className="hover:underline">
              {orgName.data?.name ?? 'one business'}
            </Link>
            <button
              type="button"
              aria-label="Show all businesses"
              className="ml-0.5 rounded-full hover:bg-primary/10"
              onClick={() => router.replace(pathname)}
            >
              <X />
            </button>
          </Badge>
        </div>
      )}

      {report.isPending ? (
        <Skeleton className="h-96" />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <div className={cn('grid gap-6', report.isPlaceholderData && 'opacity-60')}>
          {totals.length === 0 ? (
            <Card>
              <EmptyState icon={TrendingUp} title="No AI usage in this period" />
            </Card>
          ) : (
            totals.map((t) => (
              <div key={t.currency} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Billed to businesses"
                  value={formatMoney(t.billedMinor, t.currency)}
                  sub={`${formatNumber(t.requests)} AI calls`}
                />
                <Stat
                  label="Collected"
                  value={formatMoney(t.collectedMinor, t.currency)}
                  sub={
                    t.billedMinor > t.collectedMinor
                      ? `${formatMoney(t.billedMinor - t.collectedMinor, t.currency)} not covered by wallets`
                      : 'Fully covered'
                  }
                />
                <Stat
                  label="Provider cost"
                  value={formatMoney(t.costMinor, t.currency)}
                  sub={`$${formatNumber(t.costUsdMicros / 1_000_000)}`}
                />
                <Stat
                  label="Profit"
                  value={formatMoney(t.profitMinor, t.currency, { signed: true })}
                  sub={`${formatPercent(t.marginPct)} margin on collected`}
                />
              </div>
            ))
          )}

          <Card>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Breakdown</CardTitle>
                <CardDescription>Days are cut in {report.data.timezone}.</CardDescription>
              </div>
              <Segmented label="Group by" value={groupBy} onChange={setGroupBy} options={GROUPS} />
            </CardHeader>
            {groupBy === 'day' && totals[0] && (
              <CardContent>
                <ProfitChart
                  rows={report.data.rows}
                  from={report.data.from}
                  to={report.data.to}
                  currency={totals[0].currency}
                  timeZone={report.data.timezone}
                />
              </CardContent>
            )}
            <CardContent className="px-0 pb-0">
              {report.data.rows.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-muted-foreground">Nothing to show.</p>
              ) : (
                <BreakdownTable rows={report.data.rows} groupBy={groupBy} />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}

function rowLabel(r: ProfitRow, groupBy: GroupBy): React.ReactNode {
  if (groupBy === 'org')
    return (
      <Link href={`/admin/tenants/${r.key}`} className="font-medium text-primary hover:underline">
        {r.label ?? r.key}
      </Link>
    );
  if (groupBy === 'tier') return TIER_LABEL[r.key as ModelTier]?.name ?? r.key;
  if (groupBy === 'feature') return humanize(r.key.replace(/\./g, ' '));
  if (groupBy === 'model') return <span className="font-mono text-xs">{r.key || 'Unknown'}</span>;
  return longDay(r.key);
}

function BreakdownTable({ rows, groupBy }: { rows: ProfitRow[]; groupBy: GroupBy }) {
  const sorted =
    groupBy === 'day'
      ? [...rows].sort((a, b) => b.key.localeCompare(a.key))
      : [...rows].sort((a, b) => b.profitMinor - a.profitMinor);
  return (
    <div className="max-h-[32rem] overflow-y-auto">
      <Table>
        <THead>
          <TR>
            <TH>{GROUPS.find((g) => g.value === groupBy)?.label}</TH>
            <TH className="text-right">Calls</TH>
            <TH className="text-right">Tokens in / out</TH>
            <TH className="text-right">Credits</TH>
            <TH className="text-right">Collected</TH>
            <TH className="text-right">Cost</TH>
            <TH className="text-right">Profit</TH>
            <TH className="text-right">Margin</TH>
          </TR>
        </THead>
        <TBody>
          {sorted.map((r) => (
            <TR key={`${r.key}-${r.currency}`}>
              <TD>{rowLabel(r, groupBy)}</TD>
              <TD className="tabular text-right">{formatNumber(r.requests)}</TD>
              <TD className="tabular text-right whitespace-nowrap">
                {formatNumber(r.inputTokens + r.cachedInputTokens, { compact: true })} /{' '}
                {formatNumber(r.outputTokens, { compact: true })}
              </TD>
              <TD className="tabular text-right">{formatNumber(r.credits)}</TD>
              <TD className="tabular text-right">{formatMoney(r.collectedMinor, r.currency)}</TD>
              <TD className="tabular text-right">{formatMoney(r.costMinor, r.currency)}</TD>
              <TD className={cn('tabular text-right', r.profitMinor < 0 && 'text-destructive')}>
                {formatMoney(r.profitMinor, r.currency, { signed: true })}
              </TD>
              <TD className="tabular text-right">{formatPercent(r.marginPct)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function totalsByCurrency(rows: ProfitRow[]) {
  const map = new Map<
    string,
    {
      currency: string;
      requests: number;
      billedMinor: number;
      collectedMinor: number;
      costMinor: number;
      costUsdMicros: number;
      profitMinor: number;
    }
  >();
  for (const r of rows) {
    const t = map.get(r.currency) ?? {
      currency: r.currency,
      requests: 0,
      billedMinor: 0,
      collectedMinor: 0,
      costMinor: 0,
      costUsdMicros: 0,
      profitMinor: 0,
    };
    t.requests += r.requests;
    t.billedMinor += r.billedMinor;
    t.collectedMinor += r.collectedMinor;
    t.costMinor += r.costMinor;
    t.costUsdMicros += r.costUsdMicros;
    t.profitMinor += r.profitMinor;
    map.set(r.currency, t);
  }
  return [...map.values()].map((t) => ({
    ...t,
    marginPct: t.collectedMinor > 0 ? (t.profitMinor / t.collectedMinor) * 100 : null,
  }));
}
