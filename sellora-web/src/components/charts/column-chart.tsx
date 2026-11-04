'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface ColumnDatum {
  key: string;
  values: number[];
}

export interface ColumnSeries {
  name: string;
  /** CSS variable holding the series color (validated palette slots). */
  color: '--series-1' | '--series-2';
}

/** Rounds the axis maximum up to a clean number so ticks read 0 / 50 / 100. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.0001; v += step) ticks.push(Number(v.toFixed(10)));
  if (ticks.at(-1)! < max) ticks.push(Number((ticks.at(-1)! + step).toFixed(10)));
  return ticks;
}

const M = { top: 10, right: 8, bottom: 26, left: 52 };
const GAP = 2;
const RADIUS = 4;
const MAX_BAR = 24;

function columnPath(x: number, y: number, w: number, h: number, rounded: boolean): string {
  if (h <= 0) return '';
  const r = rounded ? Math.min(RADIUS, w / 2, h) : 0;
  return [
    `M${x},${y + h}`,
    `V${y + r}`,
    r ? `Q${x},${y} ${x + r},${y}` : '',
    `H${x + w - r}`,
    r ? `Q${x + w},${y} ${x + w},${y + r}` : '',
    `V${y + h}`,
    'Z',
  ].join(' ');
}

/**
 * Column chart (single or stacked) drawn in SVG: thin rounded columns from one baseline,
 * hairline grid, a per-column tooltip on hover and keyboard focus, and a table view so no
 * value depends on hovering or on color.
 */
export function ColumnChart({
  data,
  series,
  formatValue,
  formatTick = formatValue,
  formatKey,
  formatKeyLong = formatKey,
  height = 220,
  label,
  className,
}: {
  data: ColumnDatum[];
  series: ColumnSeries[];
  formatValue: (n: number) => string;
  formatTick?: (n: number) => string;
  formatKey: (key: string) => string;
  formatKeyLong?: (key: string) => string;
  height?: number;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const ticks = niceTicks(Math.max(0, ...totals));
  const yMax = ticks.at(-1) || 1;
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(MAX_BAR, band * 0.62));
  const y = (v: number) => M.top + plotH - (v / yMax) * plotH;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 64))));

  const tip = active !== null ? data[active] : undefined;
  const tipX = active !== null ? M.left + band * active + band / 2 : 0;

  return (
    <figure className={cn('relative', className)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        {series.length > 1 ? (
          <ul
            className="flex flex-wrap gap-4 text-[13px] text-muted-foreground"
            aria-label="Legend"
          >
            {series.map((s) => (
              <li key={s.name} className="flex items-center gap-1.5">
                <span
                  className="size-2.5 rounded-[2px]"
                  style={{ background: `var(${s.color})` }}
                  aria-hidden
                />
                {s.name}
              </li>
            ))}
          </ul>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="text-[13px] text-muted-foreground hover:text-foreground"
          aria-expanded={showTable}
          aria-controls={tableId}
          onClick={() => setShowTable((s) => !s)}
        >
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {showTable ? (
        <div id={tableId} className="max-h-80 overflow-y-auto rounded-md border">
          <Table>
            <THead>
              <TR>
                <TH>{label}</TH>
                {series.map((s) => (
                  <TH key={s.name} className="text-right">
                    {s.name}
                  </TH>
                ))}
                {series.length > 1 && <TH className="text-right">Total</TH>}
              </TR>
            </THead>
            <TBody>
              {data.map((d, i) => (
                <TR key={d.key}>
                  <TD>{formatKeyLong(d.key)}</TD>
                  {d.values.map((v, j) => (
                    <TD key={series[j]?.name ?? j} className="tabular text-right">
                      {formatValue(v)}
                    </TD>
                  ))}
                  {series.length > 1 && (
                    <TD className="tabular text-right">{formatValue(totals[i]!)}</TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      ) : (
        <div
          ref={ref}
          className="relative outline-none"
          style={{ height }}
          role="group"
          aria-label={`${label}. Use the left and right arrow keys to read each value.`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (!data.length) return;
            if (e.key === 'ArrowRight') setActive((a) => Math.min(data.length - 1, (a ?? -1) + 1));
            else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? data.length) - 1));
            else if (e.key === 'Escape') setActive(null);
            else return;
            e.preventDefault();
          }}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          {width > 0 && (
            <svg width={width} height={height} className="block" aria-hidden>
              {ticks.map((t) => (
                <g key={t}>
                  <line
                    x1={M.left}
                    x2={width - M.right}
                    y1={y(t)}
                    y2={y(t)}
                    stroke={t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}
                    strokeWidth={1}
                    shapeRendering="crispEdges"
                  />
                  <text
                    x={M.left - 8}
                    y={y(t)}
                    dy="0.32em"
                    textAnchor="end"
                    className="tabular fill-[var(--chart-muted)] text-[11px]"
                  >
                    {formatTick(t)}
                  </text>
                </g>
              ))}
              {data.map((d, i) => {
                const x = M.left + band * i + (band - barW) / 2;
                let acc = 0;
                const last = d.values.reduce((li, v, j) => (v > 0 ? j : li), -1);
                return (
                  <g key={d.key} opacity={active === null || active === i ? 1 : 0.45}>
                    {d.values.map((v, j) => {
                      if (v <= 0) return null;
                      const top = y(acc + v);
                      const bottom = y(acc) - (acc > 0 ? GAP : 0);
                      acc += v;
                      return (
                        <path
                          key={j}
                          d={columnPath(x, top, barW, Math.max(0, bottom - top), j === last)}
                          fill={`var(${series[j]?.color ?? '--series-1'})`}
                        />
                      );
                    })}
                    {i % labelEvery === 0 && (
                      <text
                        x={x + barW / 2}
                        y={height - 8}
                        textAnchor="middle"
                        className="fill-[var(--chart-muted)] text-[11px]"
                      >
                        {formatKey(d.key)}
                      </text>
                    )}
                    <rect
                      x={M.left + band * i}
                      y={M.top}
                      width={band}
                      height={plotH}
                      fill="transparent"
                      onPointerEnter={() => setActive(i)}
                      onPointerDown={() => setActive(i)}
                    />
                  </g>
                );
              })}
            </svg>
          )}
          {tip && (
            <div
              className="pointer-events-none absolute top-0 z-10 min-w-36 -translate-x-1/2 rounded-lg border bg-popover px-3 py-2 text-[13px] shadow-md"
              style={{ left: Math.min(Math.max(tipX, 80), Math.max(80, width - 80)) }}
              role="status"
            >
              <p className="mb-1 text-muted-foreground">{formatKeyLong(tip.key)}</p>
              {series.map((s, j) => (
                <p key={s.name} className="flex items-center gap-2">
                  <span
                    className="h-0.5 w-3 rounded"
                    style={{ background: `var(${s.color})` }}
                    aria-hidden
                  />
                  <span className="font-semibold">{formatValue(tip.values[j] ?? 0)}</span>
                  <span className="text-muted-foreground">{s.name}</span>
                </p>
              ))}
              {series.length > 1 && (
                <p className="mt-1 border-t pt-1">
                  <span className="font-semibold">{formatValue(totals[active!]!)}</span>{' '}
                  <span className="text-muted-foreground">total</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
