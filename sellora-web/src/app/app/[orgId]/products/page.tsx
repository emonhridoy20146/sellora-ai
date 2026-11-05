'use client';

import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Package, Plus, RefreshCw, Search } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ProductStatusBadge, StockBadge } from '@/components/commerce/badges';
import { commerceKeys, useCategories, useShopSettings } from '@/components/commerce/hooks';
import { PageError } from '@/components/commerce/page-error';
import { ProductThumb } from '@/components/commerce/product-thumb';
import { ProductsTabs } from '@/components/commerce/products-tabs';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, NativeSelect } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import type { Page, Product } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

function priceText(p: Product) {
  const { minMinor, maxMinor } = p.priceRange;
  const min = formatMoney(minMinor, p.currency);
  return minMinor === maxMinor ? min : `${min} – ${formatMoney(maxMinor, p.currency)}`;
}

export default function ProductsPage() {
  const { org, can } = useOrg();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const params = useSearchParams();
  const [stock, setStock] = useState(() => {
    const v = params.get('stock');
    return v === 'low' || v === 'out' ? v : '';
  });
  const [categoryId, setCategoryId] = useState('');
  const q = useDebounced(search.trim());
  const settings = useShopSettings(org.id);
  const categories = useCategories(org.id);
  const threshold = settings.data?.lowStockThreshold ?? 3;
  const filtered = Boolean(q || status || stock || categoryId);

  const list = useInfiniteQuery({
    queryKey: [...commerceKeys.products(org.id), 'list', q, status, stock, categoryId],
    queryFn: ({ pageParam }) =>
      api<Page<Product>>(`/orgs/${org.id}/products`, {
        query: { q, status, stock, categoryId, limit: 25, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Products"
        description="What you sell, with prices and stock. Orders take stock automatically."
        actions={
          can('catalog.manage') && (
            <Button asChild>
              <Link href={`/app/${org.id}/products/new`}>
                <Plus /> Add product
              </Link>
            </Button>
          )
        }
      />
      <ProductsTabs orgId={org.id} />
      <Card>
        <div className="flex flex-wrap gap-2 border-b px-5 py-3">
          <div className="relative min-w-56 flex-1">
            <Search
              className="absolute top-2.5 left-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <label htmlFor="p-search" className="sr-only">
              Search products
            </label>
            <Input
              id="p-search"
              className="h-9 pl-8"
              placeholder="Name, SKU or tag"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label htmlFor="p-status-f" className="sr-only">
            Status
          </label>
          <NativeSelect
            id="p-status-f"
            className="w-36"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Active and draft</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </NativeSelect>
          <label htmlFor="p-stock-f" className="sr-only">
            Stock
          </label>
          <NativeSelect
            id="p-stock-f"
            className="w-36"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
          >
            <option value="">Any stock</option>
            <option value="low">Low stock</option>
            <option value="out">Out of stock</option>
          </NativeSelect>
          {(categories.data?.length ?? 0) > 0 && (
            <>
              <label htmlFor="p-cat-f" className="sr-only">
                Category
              </label>
              <NativeSelect
                id="p-cat-f"
                className="w-40"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">All categories</option>
                {categories.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </>
          )}
        </div>
        <CardContent className={cn('px-0 py-0', list.isPlaceholderData && 'opacity-60')}>
          {list.isPending ? (
            <Skeleton className="m-5 h-40" />
          ) : list.isError ? (
            <PageError error={list.error} onRetry={() => void list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={Package}
              title={filtered ? 'No products match' : 'No products yet'}
              action={
                !filtered &&
                can('catalog.manage') && (
                  <Button asChild>
                    <Link href={`/app/${org.id}/products/new`}>
                      <Plus /> Add your first product
                    </Link>
                  </Button>
                )
              }
            >
              {!filtered &&
                'Add products with their sizes, colours and stock. The AI agent will use them to answer customers.'}
            </EmptyState>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH className="text-right">Price</TH>
                  <TH className="text-right">Stock</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Sold</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((p) => {
                  const lowVariants = p.stock.lowVariants ?? 0;
                  return (
                    <TR key={p.id}>
                      <TD>
                        <Link
                          href={`/app/${org.id}/products/${p.id}`}
                          className="flex items-center gap-3"
                        >
                          <ProductThumb url={p.images[0]?.url} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-primary hover:underline">
                              {p.name}
                            </span>
                            <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                              {p.sync && (
                                <RefreshCw
                                  className="size-3 shrink-0"
                                  aria-label="Synced from a source"
                                />
                              )}
                              {p.variants.length > 1
                                ? `${p.variants.length} variants`
                                : (p.variants[0]?.sku ?? 'No SKU')}
                            </span>
                          </span>
                        </Link>
                      </TD>
                      <TD className="tabular text-right whitespace-nowrap">{priceText(p)}</TD>
                      <TD className="text-right whitespace-nowrap">
                        {p.variants.length > 1 && p.stock.tracked ? (
                          <span className="inline-flex flex-col items-end">
                            <span className="tabular">{p.stock.total}</span>
                            {lowVariants > 0 && (
                              <span className="text-xs text-warning">
                                {lowVariants} running low
                              </span>
                            )}
                          </span>
                        ) : (
                          <StockBadge
                            tracked={p.stock.tracked}
                            stock={p.stock.total}
                            threshold={threshold}
                          />
                        )}
                      </TD>
                      <TD>
                        <ProductStatusBadge status={p.status} />
                      </TD>
                      <TD className="tabular text-right text-muted-foreground">{p.soldCount}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
          <LoadMore
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          />
        </CardContent>
      </Card>
    </>
  );
}
