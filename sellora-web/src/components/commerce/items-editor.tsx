'use client';

import { Minus, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Product, Variant } from '@/lib/api/types';
import { formatMoney, minorToInput, parseMoney } from '@/lib/format';
import { MoneyInput } from './money-input';
import { ProductThumb } from './product-thumb';

export interface DraftLine {
  productId: string;
  variantId: string;
  name: string;
  variantTitle: string;
  imageUrl: string | null;
  /** What the person typed as the unit price. */
  price: string;
  quantity: number;
  /** Stock on hand when picked; null when the variant does not track stock or is unknown. */
  stock: number | null;
}

export function lineFromVariant(p: Product, v: Variant): DraftLine {
  return {
    productId: p.id,
    variantId: v.id,
    name: p.name,
    variantTitle: v.title === 'Default' ? '' : v.title,
    imageUrl: p.images[0]?.url ?? null,
    price: minorToInput(v.priceMinor, p.currency),
    quantity: 1,
    stock: v.trackStock ? v.stock : null,
  };
}

/** Adds a picked variant, or bumps its quantity when it is already on the order. */
export function addLine(lines: DraftLine[], line: DraftLine): DraftLine[] {
  const existing = lines.find((l) => l.variantId === line.variantId);
  if (!existing) return [...lines, line];
  return lines.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l));
}

/** Order lines with editable price and quantity. */
export function ItemsEditor({
  lines,
  onChange,
  currency,
  errors = {},
}: {
  lines: DraftLine[];
  onChange: (lines: DraftLine[]) => void;
  currency: string;
  errors?: Record<number, string | undefined>;
}) {
  const update = (i: number, patch: Partial<DraftLine>) =>
    onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  if (!lines.length)
    return (
      <p className="py-3 text-sm text-muted-foreground">
        No items yet. Search above to add products.
      </p>
    );
  return (
    <ul className="divide-y rounded-md border">
      {lines.map((l, i) => {
        const unit = parseMoney(l.price, currency);
        const over = l.stock !== null && l.quantity > l.stock;
        return (
          <li key={l.variantId} className="grid gap-3 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="flex min-w-0 items-center gap-3">
              <ProductThumb url={l.imageUrl} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{l.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[l.variantTitle, l.stock !== null ? `${l.stock} in stock` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {(errors[i] || over) && (
                  <p role="alert" className="text-xs text-destructive">
                    {errors[i] ?? `Only ${l.stock} in stock`}
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={`line-${i}-price`}>
                Unit price of {l.name}
              </label>
              <MoneyInput
                id={`line-${i}-price`}
                currency={currency}
                className="w-28"
                value={l.price}
                aria-invalid={unit === null}
                onChange={(e) => update(i, { price: e.target.value })}
              />
              <div className="flex items-center">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`One less ${l.name}`}
                  disabled={l.quantity <= 1}
                  onClick={() => update(i, { quantity: l.quantity - 1 })}
                >
                  <Minus />
                </Button>
                <label className="sr-only" htmlFor={`line-${i}-qty`}>
                  Quantity of {l.name}
                </label>
                <Input
                  id={`line-${i}-qty`}
                  inputMode="numeric"
                  className="tabular mx-1 w-14 text-center"
                  value={String(l.quantity)}
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(/\D/g, ''));
                    update(i, { quantity: Math.min(100_000, Math.max(1, n || 1)) });
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`One more ${l.name}`}
                  onClick={() => update(i, { quantity: l.quantity + 1 })}
                >
                  <Plus />
                </Button>
              </div>
              <span className="tabular w-24 text-right text-sm font-medium">
                {unit === null ? '–' : formatMoney(unit * l.quantity, currency)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${l.name}`}
                onClick={() => onChange(lines.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
