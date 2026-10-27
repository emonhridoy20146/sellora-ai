import type * as React from 'react';
import { cn } from '@/lib/utils';

/** Stat tile: label, value, optional context line. Values use proportional figures. */
export function Stat({
  label,
  value,
  sub,
  className,
  children,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn('rounded-lg border bg-card p-4 shadow-xs', className)}>
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight">{value}</p>
      {sub && <p className="mt-1 text-[13px] text-muted-foreground">{sub}</p>}
      {children}
    </div>
  );
}
