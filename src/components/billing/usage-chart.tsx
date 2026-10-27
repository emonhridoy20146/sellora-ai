'use client';

import { ColumnChart } from '@/components/charts/column-chart';
import type { UsageSummary } from '@/lib/api/types';
import { formatNumber } from '@/lib/format';
import { daysBetween, longDay, shortDay } from '@/lib/series';

/** AI credits used per day in the business's time zone, quiet days shown as zero. */
export function UsageChart({
  summary,
  timeZone,
  height,
}: {
  summary: UsageSummary;
  timeZone: string;
  height?: number;
}) {
  const byDay = new Map(summary.byDay.map((d) => [d.date, d.credits]));
  const data = daysBetween(summary.from, summary.to, timeZone).map((key) => ({
    key,
    values: [byDay.get(key) ?? 0],
  }));
  return (
    <ColumnChart
      label="Day"
      data={data}
      series={[{ name: 'credits', color: '--series-1' }]}
      formatValue={(n) => formatNumber(n, { digits: 2 })}
      formatTick={(n) => formatNumber(n, { compact: true })}
      formatKey={shortDay}
      formatKeyLong={longDay}
      height={height}
    />
  );
}
