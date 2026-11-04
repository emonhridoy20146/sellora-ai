'use client';

import type * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const symbols = new Map<string, string>();

export function currencySymbol(currency: string): string {
  let s = symbols.get(currency);
  if (!s) {
    try {
      s =
        new Intl.NumberFormat('en', {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
        })
          .formatToParts(0)
          .find((p) => p.type === 'currency')?.value ?? currency;
    } catch {
      s = currency;
    }
    symbols.set(currency, s);
  }
  return s;
}

/** A text input for an amount, with the currency symbol in front. Parse with parseMoney. */
export function MoneyInput({
  currency,
  className,
  ...props
}: React.ComponentProps<'input'> & { currency: string }) {
  const symbol = currencySymbol(currency);
  return (
    <div className={cn('relative', className)}>
      <span
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground"
        aria-hidden
      >
        {symbol}
      </span>
      <Input
        inputMode="decimal"
        autoComplete="off"
        className="tabular"
        style={{ paddingLeft: `${0.75 + symbol.length * 0.55 + 0.35}rem` }}
        {...props}
      />
    </div>
  );
}
