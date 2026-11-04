'use client';

import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { commerceKeys } from '@/components/commerce/hooks';
import { ProductThumb } from '@/components/commerce/product-thumb';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import type { CampaignOptions, LinkInput, LinkKind, Page, Product } from '@/lib/api/types';

/** The link and the page name the editor shows for it. */
export interface LinkDraft extends LinkInput {
  label: string | null;
}

const KINDS: { value: LinkKind; label: string }[] = [
  { value: 'none', label: 'No link' },
  { value: 'store', label: 'Store' },
  { value: 'landing_page', label: 'Landing page' },
  { value: 'product', label: 'Product' },
];

/**
 * Where {link} in the text goes: the store's home page, a live landing page or a product on
 * sale. The API checks the choice again when the campaign is saved and when it starts.
 */
export function LinkPicker({
  id,
  orgId,
  value,
  onChange,
  options,
  editable,
  error,
}: {
  id: string;
  orgId: string;
  value: LinkDraft;
  onChange: (v: LinkDraft) => void;
  options: Pick<CampaignOptions, 'stores' | 'landingPages'>;
  editable: boolean;
  error?: string | null;
}) {
  const stores = options.stores;
  const noStore = stores.length === 0;
  const setKind = (kind: LinkKind) => {
    if (!editable) return;
    if (kind === 'none') return onChange({ kind, label: null });
    if (kind === 'store') {
      const s = stores.find((x) => x.id === value.storeId) ?? stores[0];
      return onChange({ kind, storeId: s?.id, label: s?.name ?? null });
    }
    if (kind === 'landing_page') {
      const p = options.landingPages[0];
      return onChange({ kind, targetId: p?.id, storeId: p?.storeId, label: p?.name ?? null });
    }
    onChange({ kind, storeId: stores[0]?.id, label: null });
  };

  return (
    <div className="grid gap-3">
      <Segmented
        label="Where the link goes"
        value={value.kind}
        onChange={setKind}
        options={KINDS}
      />
      {value.kind !== 'none' && noStore && (
        <p className="text-[13px] text-muted-foreground">
          Links go to a page of your online store.{' '}
          <Link href={`/app/${orgId}/store`} className="font-medium text-primary underline">
            Make your store first
          </Link>
          .
        </p>
      )}
      {value.kind === 'store' && stores.length > 1 && (
        <label className="grid max-w-sm gap-1.5 text-sm">
          <span className="font-medium">Store</span>
          <NativeSelect
            id={`${id}-store`}
            value={value.storeId ?? ''}
            disabled={!editable}
            onChange={(e) => {
              const s = stores.find((x) => x.id === e.target.value);
              onChange({ kind: 'store', storeId: s?.id, label: s?.name ?? null });
            }}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}
      {value.kind === 'store' && stores.length === 1 && (
        <p className="text-[13px] text-muted-foreground">
          The home page of {stores[0]!.name} ({stores[0]!.url.replace(/^https?:\/\//, '')}).
        </p>
      )}
      {value.kind === 'landing_page' &&
        (options.landingPages.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No landing page is live yet.{' '}
            <Link
              href={`/app/${orgId}/landing-pages`}
              className="font-medium text-primary underline"
            >
              Landing pages
            </Link>
          </p>
        ) : (
          <label className="grid max-w-sm gap-1.5 text-sm">
            <span className="font-medium">Landing page</span>
            <NativeSelect
              id={`${id}-page`}
              value={value.targetId ?? ''}
              disabled={!editable}
              onChange={(e) => {
                const p = options.landingPages.find((x) => x.id === e.target.value);
                onChange({
                  kind: 'landing_page',
                  targetId: p?.id,
                  storeId: p?.storeId,
                  label: p?.name ?? null,
                });
              }}
            >
              {options.landingPages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (/{p.slug})
                </option>
              ))}
            </NativeSelect>
          </label>
        ))}
      {value.kind === 'product' && !noStore && (
        <ProductChoice
          id={id}
          orgId={orgId}
          value={value}
          editable={editable}
          onPick={(p) =>
            onChange({ kind: 'product', storeId: value.storeId, targetId: p.id, label: p.name })
          }
          onClear={() => onChange({ kind: 'product', storeId: value.storeId, label: null })}
        />
      )}
      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function ProductChoice({
  id,
  orgId,
  value,
  editable,
  onPick,
  onClear,
}: {
  id: string;
  orgId: string;
  value: LinkDraft;
  editable: boolean;
  onPick: (p: Product) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 200);
  const results = useQuery({
    queryKey: [...commerceKeys.products(orgId), 'link-picker', q],
    queryFn: () =>
      api<Page<Product>>(`/orgs/${orgId}/products`, { query: { q, limit: 8, status: 'active' } }),
    enabled: q.length > 0,
  });

  if (value.targetId)
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>
          Goes to <span className="font-medium">{value.label ?? 'the chosen product'}</span>
        </span>
        {editable && (
          <Button variant="outline" size="sm" onClick={onClear}>
            Change product
          </Button>
        )}
      </div>
    );
  return (
    <div className="grid max-w-md gap-2">
      <div className="relative">
        <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
        <label htmlFor={`${id}-product`} className="sr-only">
          Find a product
        </label>
        <Input
          id={`${id}-product`}
          className="pl-8"
          placeholder="Search a product on sale"
          value={search}
          disabled={!editable}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
        />
      </div>
      {q && (
        <div className="max-h-64 overflow-y-auto rounded-md border bg-card">
          {results.isPending ? (
            <p className="p-3 text-sm text-muted-foreground">Searching…</p>
          ) : results.isError ? (
            <p className="p-3 text-sm text-destructive">Products could not be loaded.</p>
          ) : results.data.items.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No product on sale matches “{q}”.</p>
          ) : (
            <ul className="divide-y">
              {results.data.items.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 p-2 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      onPick(p);
                      setSearch('');
                    }}
                  >
                    <ProductThumb url={p.images[0]?.url} className="size-8" />
                    <span className="truncate font-medium">{p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
