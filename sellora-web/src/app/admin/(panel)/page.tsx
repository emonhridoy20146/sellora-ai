'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { ProfitChart } from '@/components/charts/profit-chart';
import { usePlatform } from '@/components/platform-context';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import type { BillingOverview, PlatformOverview, ProfitReport } from '@/lib/api/types';
import { formatMoney, formatNumber, formatPercent, humanize } from '@/lib/format';
import { rangeFromDays } from '@/lib/series';

export default function AdminOverviewPage() {
  const { can, me } = usePlatform();
  const overview = useQuery({
    queryKey: ['platform', 'overview'],
    queryFn: () => api<PlatformOverview>('/platform/overview'),
    enabled: can('platform.tenants.view'),
  });
  const billing = useQuery({
    queryKey: ['platform', 'billing', 'overview'],
    queryFn: () => api<BillingOverview>('/platform/billing/overview'),
    enabled: can('platform.billing.view'),
  });
  const range = rangeFromDays(30);
  const profit = useQuery({
    queryKey: ['platform', 'billing', 'profit', 'day', 30],
    queryFn: () =>
      api<ProfitReport>('/platform/billing/ai-profit', { query: { ...range, groupBy: 'day' } }),
    enabled: can('platform.billing.view'),
  });
  const o = overview.data;
  const b = billing.data;
  const currency = b?.ai[0]?.currency ?? b?.wallets[0]?.currency ?? 'BDT';
  const ai = b?.ai.find((a) => a.currency === currency);
  const q = b?.queues;

  return (
    <>
      <PageHeader
        title={`Hello, ${me.name.split(' ')[0]}`}
        description="The whole platform at a glance. Money figures cover the last 30 days."
      />
      {q && (q.pendingManualPayments > 0 || q.openWithdrawals > 0) && (
        <Alert tone="warning" title="Waiting for you" className="mb-6">
          {q.pendingManualPayments > 0 && (
            <Link href="/admin/payments" className="mr-4 underline">
              {q.pendingManualPayments} transfer{q.pendingManualPayments === 1 ? '' : 's'} to check
            </Link>
          )}
          {q.openWithdrawals > 0 && (
            <Link href="/admin/withdrawals" className="underline">
              {q.openWithdrawals} withdrawal{q.openWithdrawals === 1 ? '' : 's'} to handle
            </Link>
          )}
        </Alert>
      )}
      {can('platform.tenants.view') && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {!o ? (
            Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[104px]" />)
          ) : (
            <>
              <Stat
                label="Businesses"
                value={formatNumber(o.tenants)}
                sub={`${o.activeTenants} active · ${o.suspendedTenants} suspended`}
              />
              <Stat
                label="New businesses · 7 days"
                value={formatNumber(o.newTenantsWeek)}
                sub={`${o.demoTenants} demo accounts`}
              />
              <Stat
                label="Merchant users"
                value={formatNumber(o.users)}
                sub={`${o.newUsersToday} joined today`}
              />
              <Stat
                label="Monthly recurring revenue"
                value={
                  b?.mrr[0]
                    ? formatMoney(b.mrr[0].mrrMinor, b.mrr[0].currency)
                    : formatMoney(0, currency)
                }
                sub={
                  b?.mrr[0]
                    ? `${b.mrr[0].payingBusinesses} paying businesses`
                    : 'No paying businesses yet'
                }
              />
            </>
          )}
        </div>
      )}
      {can('platform.billing.view') && (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {!b ? (
              Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[104px]" />)
            ) : (
              <>
                <Stat
                  label="AI billed"
                  value={formatMoney(ai?.billedMinor ?? 0, currency)}
                  sub={`${formatNumber(ai?.requests ?? 0)} requests`}
                />
                <Stat
                  label="AI provider cost"
                  value={formatMoney(ai?.costMinor ?? 0, currency)}
                  sub="What the AI companies charge us"
                />
                <Stat
                  label="AI profit"
                  value={formatMoney(ai?.profitMinor ?? 0, currency)}
                  sub={`Margin ${formatPercent(ai?.marginPct)}`}
                />
                <Stat
                  label="Money in wallets"
                  value={formatMoney(
                    b.wallets.find((w) => w.currency === currency)?.cashMinor ?? 0,
                    currency,
                  )}
                  sub={`plus ${formatMoney(b.wallets.find((w) => w.currency === currency)?.bonusMinor ?? 0, currency)} free credit`}
                />
              </>
            )}
          </div>
          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle>AI cost and profit per day</CardTitle>
                <CardDescription>
                  Each column is what we billed for AI that day ({currency}), split into provider
                  cost and our profit.
                  {profit.data && ` Days in ${profit.data.timezone.replaceAll('_', ' ')} time.`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {profit.data ? (
                  <ProfitChart
                    rows={profit.data.rows}
                    from={profit.data.from}
                    to={profit.data.to}
                    currency={currency}
                    timeZone={profit.data.timezone}
                  />
                ) : (
                  <Skeleton className="h-[250px]" />
                )}
                <Button asChild variant="link" size="sm" className="mt-2">
                  <Link href="/admin/profit">
                    Profit by business, model and feature <ArrowRight />
                  </Link>
                </Button>
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Subscriptions</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-2">
                {b && b.subscriptions.length > 0 ? (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Plan</TH>
                        <TH>Status</TH>
                        <TH className="text-right">Businesses</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {[...b.subscriptions]
                        .sort((x, y) => y.count - x.count)
                        .map((s) => (
                          <TR key={`${s.planCode}-${s.status}`}>
                            <TD>{humanize(s.planCode)}</TD>
                            <TD>
                              <StatusBadge status={s.status} />
                            </TD>
                            <TD className="tabular text-right">{s.count}</TD>
                          </TR>
                        ))}
                    </TBody>
                  </Table>
                ) : (
                  <p className="px-5 text-sm text-muted-foreground">No subscriptions yet.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
