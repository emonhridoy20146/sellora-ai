'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ColumnChart } from '@/components/charts/column-chart';
import { PageError } from '@/components/commerce/page-error';
import { useLandingStats } from '@/components/landing/hooks';
import { useOrg } from '@/components/org-context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { formatMoney, formatNumber } from '@/lib/format';
import { conversionText } from '@/lib/landing';
import { longDay, shortDay } from '@/lib/series';

type Range = '7' | '30' | '90';

export default function LandingStatsPage() {
  const { org } = useOrg();
  const { pageId } = useParams<{ pageId: string }>();
  const [range, setRange] = useState<Range>('30');
  const stats = useLandingStats(org.id, pageId, Number(range));

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Days in your business’s time zone ({org.timezone}).
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
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Visitors" value={formatNumber(stats.data.total.visitors)} />
            <Stat label="Orders" value={formatNumber(stats.data.total.orders)} />
            <Stat
              label="Conversion"
              value={conversionText(stats.data.conversionRate)}
              sub="Orders per visitor"
            />
            <Stat
              label="Order value"
              value={formatMoney(stats.data.total.revenueMinor, stats.data.currency)}
              sub="Before cancellations"
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Visitors per day</CardTitle>
              <CardDescription>
                One browser counts once a day. Link previews and most bots are not counted.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ColumnChart
                label="Day"
                data={stats.data.days.map((d) => ({ key: d.day, values: [d.visitors] }))}
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
              <CardTitle>Orders per day</CardTitle>
              <CardDescription>
                Every order placed on the page, counted when it was placed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ColumnChart
                label="Day"
                data={stats.data.days.map((d) => ({ key: d.day, values: [d.orders] }))}
                series={[{ name: 'Orders', color: '--series-1' }]}
                formatValue={(n) => formatNumber(n)}
                formatTick={(n) => formatNumber(n, { compact: true })}
                formatKey={shortDay}
                formatKeyLong={longDay}
                height={200}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
