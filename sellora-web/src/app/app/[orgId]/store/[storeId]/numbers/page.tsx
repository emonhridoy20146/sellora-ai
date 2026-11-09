'use client';

import { BarChart3 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ColumnChart } from '@/components/charts/column-chart';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { useStoreStats } from '@/components/stores/hooks';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import type { StoreStats } from '@/lib/api/types';
import { formatMoney, formatNumber, minorDigits } from '@/lib/format';
import { conversionText } from '@/lib/landing';
import { longDay, shortDay } from '@/lib/series';
import { SOURCE_LABEL, changeText, funnelRows, isEmpty } from '@/lib/store-numbers';

type Range = '7' | '30' | '90';

export default function StoreNumbersPage() {
  const { org } = useOrg();
  const { storeId } = useParams<{ storeId: string }>();
  const [range, setRange] = useState<Range>('30');
  const days = Number(range);
  const stats = useStoreStats(org.id, storeId, days);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Days in your business’s time zone ({org.timezone}). Each shopper counts once a day.
        </p>
        <Segmented<Range>
          label="Period"
          value={range}
          onChange={setRange}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
      </div>
      {stats.isPending ? (
        <Skeleton className="h-72" />
      ) : stats.isError ? (
        <PageError error={stats.error} onRetry={() => void stats.refetch()} />
      ) : isEmpty(stats.data) ? (
        <Card>
          <EmptyState icon={BarChart3} title="No shoppers in this period yet">
            Numbers start when the store is open. Previews by you or the reviewer are never counted.
          </EmptyState>
        </Card>
      ) : (
        <Numbers s={stats.data} days={days} />
      )}
    </div>
  );
}

function Numbers({ s, days }: { s: StoreStats; days: number }) {
  const money = (minor: number) => formatMoney(minor, s.currency);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Visitors"
          value={formatNumber(s.total.visitors)}
          sub={changeText(s.total.visitors, s.previous.visitors, days) ?? undefined}
        />
        <Stat
          label="Orders"
          value={formatNumber(s.total.orders)}
          sub={changeText(s.total.orders, s.previous.orders, days) ?? undefined}
        />
        <Stat
          label="Conversion"
          value={conversionText(s.conversionRate)}
          sub="Orders per visitor"
        />
        <Stat label="Order value" value={money(s.total.revenueMinor)} sub="Before cancellations" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How far shoppers got</CardTitle>
          <CardDescription>
            Of the shoppers who visited, how many took each next step. A big drop shows where to
            look: product pictures and prices, delivery charges, or the checkout.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3" aria-label="Shopper steps">
            {funnelRows(s.funnel).map((f) => (
              <li
                key={f.step}
                className="grid gap-1.5 sm:grid-cols-[12rem_1fr_6rem] sm:items-center"
              >
                <span className="text-sm">{f.label}</span>
                <span className="h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${f.share ?? 0}%`, background: 'var(--series-1)' }}
                  />
                </span>
                <span className="tabular text-sm sm:text-right">
                  {formatNumber(f.shoppers)}
                  {f.share !== null && f.step !== 'visited' ? (
                    <span className="text-muted-foreground"> · {f.share}%</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Visitors per day</CardTitle>
          </CardHeader>
          <CardContent>
            <ColumnChart
              label="Day"
              data={s.days.map((d) => ({ key: d.day, values: [d.visitors] }))}
              series={[{ name: 'Visitors', color: '--series-1' }]}
              formatValue={(n) => formatNumber(n)}
              formatTick={(n) => formatNumber(n, { compact: true })}
              formatKey={shortDay}
              formatKeyLong={longDay}
              height={200}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Order value per day</CardTitle>
          </CardHeader>
          <CardContent>
            <ColumnChart
              label="Day"
              data={s.days.map((d) => ({ key: d.day, values: [d.revenueMinor] }))}
              series={[{ name: 'Order value', color: '--series-1' }]}
              formatValue={money}
              formatTick={(n) => formatNumber(n / 10 ** minorDigits(s.currency), { compact: true })}
              formatKey={shortDay}
              formatKeyLong={longDay}
              height={200}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Where shoppers came from</CardTitle>
            <CardDescription>
              From the ad’s tags (utm_source) or the site that sent them.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {s.sources.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">Nothing yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Source</TH>
                    <TH className="text-right">Visitors</TH>
                    <TH className="text-right">Orders</TH>
                  </TR>
                </THead>
                <TBody>
                  {s.sources.map((r) => (
                    <TR key={r.source}>
                      <TD>{SOURCE_LABEL[r.source] ?? r.source}</TD>
                      <TD className="tabular text-right">{formatNumber(r.visitors)}</TD>
                      <TD className="tabular text-right">{formatNumber(r.orders)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Products shoppers looked at</CardTitle>
            <CardDescription>
              Many looks and few orders: check the price or pictures.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {s.products.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">Nothing yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH className="text-right">Looked</TH>
                    <TH className="text-right">Orders</TH>
                    <TH className="text-right">Sales</TH>
                  </TR>
                </THead>
                <TBody>
                  {s.products.map((p) => (
                    <TR key={p.productId}>
                      <TD className="max-w-56 truncate" title={p.name ?? undefined}>
                        {p.name ?? 'Removed product'}
                      </TD>
                      <TD className="tabular text-right">{formatNumber(p.viewers)}</TD>
                      <TD className="tabular text-right">{formatNumber(p.orders)}</TD>
                      <TD className="tabular text-right">{money(p.revenueMinor)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
