'use client';

import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import type { Page, Product, Variant } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { commerceKeys } from './hooks';
import { ProductThumb } from './product-thumb';

/** Search the catalog and pick a variant to add to an order. */
export function ProductPicker({
  orgId,
  onPick,
}: {
  orgId: string;
  onPick: (product: Product, variant: Variant) => void;
}) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 200);
  const results = useQuery({
    queryKey: [...commerceKeys.products(orgId), 'picker', q],
    queryFn: () =>
      api<Page<Product>>(`/orgs/${orgId}/products`, { query: { q, limit: 8, status: 'active' } }),
    enabled: q.length > 0,
  });

  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
        <label htmlFor="picker" className="sr-only">
          Find a product
        </label>
        <Input
          id="picker"
          className="pl-8"
          placeholder="Search products by name or SKU to add them"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
        />
      </div>
      {q && (
        <div className="max-h-80 overflow-y-auto rounded-md border bg-card">
          {results.isPending ? (
            <p className="p-3 text-sm text-muted-foreground">Searching…</p>
          ) : results.isError ? (
            <p className="p-3 text-sm text-destructive">Products could not be loaded.</p>
          ) : results.data.items.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No active product matches “{q}”.</p>
          ) : (
            <ul className="divide-y">
              {results.data.items.map((p) => (
                <li key={p.id} className="p-2">
                  <div className="flex items-center gap-3 px-1 pb-1.5">
                    <ProductThumb url={p.images[0]?.url} className="size-8" />
                    <span className="truncate text-sm font-medium">{p.name}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pl-12">
                    {p.variants.map((v) => {
                      const out = v.trackStock && v.stock <= 0;
                      return (
                        <button
                          key={v.id}
                          type="button"
                          disabled={out}
                          onClick={() => {
                            onPick(p, v);
                            setSearch('');
                          }}
                          className={cn(
                            'rounded-md border px-2.5 py-1 text-left text-[13px] transition-colors',
                            out
                              ? 'cursor-not-allowed opacity-50'
                              : 'hover:border-primary hover:bg-info-soft',
                          )}
                        >
                          <span className="font-medium">
                            {v.title === 'Default' ? 'Add' : v.title}
                          </span>{' '}
                          <span className="tabular text-muted-foreground">
                            {formatMoney(v.priceMinor, p.currency)}
                            {v.trackStock && ` · ${out ? 'out of stock' : `${v.stock} left`}`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
