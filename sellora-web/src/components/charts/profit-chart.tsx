'use client';

import { ColumnChart } from '@/components/charts/column-chart';
import type { ProfitRow } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import { daysBetween, longDay, shortDay } from '@/lib/series';

/** What AI usage cost us versus what we kept, per day, stacked to the amount billed. */
export function ProfitChart({
  rows,
  from,
  to,
  currency,
  timeZone = 'UTC',
  height,
}: {
  rows: ProfitRow[];
  from: string;
  to: string;
  currency: string;
  timeZone?: string;
  height?: number;
}) {
  const byDay = new Map(rows.filter((r) => r.currency === currency).map((r) => [r.key, r]));
  const data = daysBetween(from, to, timeZone).map((key) => {
    const r = byDay.get(key);
    return { key, values: [r?.costMinor ?? 0, Math.max(0, r?.profitMinor ?? 0)] };
  });
  return (
    <ColumnChart
      label="Day"
      data={data}
      series={[
        { name: 'Provider cost', color: '--series-2' },
        { name: 'Profit', color: '--series-1' },
      ]}
      formatValue={(n) => formatMoney(n, currency)}
      formatTick={(n) => formatMoney(n, currency, { compact: true })}
      formatKey={shortDay}
      formatKeyLong={longDay}
      height={height}
    />
  );
}
