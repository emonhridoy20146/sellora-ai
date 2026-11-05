'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useCatalogSources } from '@/components/catalog-sync/shared';
import { ProductStatusBadge, StockBadge } from '@/components/commerce/badges';
import { commerceKeys, useShopSettings } from '@/components/commerce/hooks';
import { PageError } from '@/components/commerce/page-error';
import { ProductForm } from '@/components/commerce/product-form';
import { StockAdjustDialog } from '@/components/commerce/stock-adjust-dialog';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LoadMore } from '@/components/ui/load-more';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Page, Product, StockMovement, Variant } from '@/lib/api/types';
import { STOCK_REASON } from '@/lib/commerce';
import { formatDateTime, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

function StockHistory({
  orgId,
  product,
  timezone,
}: {
  orgId: string;
  product: Product;
  timezone: string;
}) {
  const q = useInfiniteQuery({
    queryKey: commerceKeys.stock(orgId, product.id),
    queryFn: ({ pageParam }) =>
      api<Page<StockMovement>>(`/orgs/${orgId}/stock-movements`, {
        query: { productId: product.id, limit: 15, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const title = (variantId: string) => {
    const v = product.variants.find((x) => x.id === variantId);
    return v && v.title !== 'Default' ? v.title : null;
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Stock history</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {q.isPending ? (
          <Skeleton className="mx-5 mb-5 h-24" />
        ) : items.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">No stock changes yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {items.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0">
                  <p className="font-medium">
                    {STOCK_REASON[m.reason]}
                    {m.reference?.type === 'order' && (
                      <>
                        {' '}
                        <Link
                          href={`/app/${orgId}/orders/${m.reference.id}`}
                          className="font-mono text-primary hover:underline"
                        >
                          {m.reference.label}
                        </Link>
                      </>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[title(m.variantId), formatDateTime(m.at, timezone), m.note]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="text-right">
                  <p
                    className={cn(
                      'tabular font-medium',
                      m.delta > 0 ? 'text-success' : 'text-destructive',
                    )}
                  >
                    {m.delta > 0 ? `+${m.delta}` : m.delta}
                  </p>
                  <p className="tabular text-xs text-muted-foreground">{m.stockAfter} left</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <LoadMore
          hasMore={Boolean(q.hasNextPage)}
          loading={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        />
      </CardContent>
    </Card>
  );
}

/** Says where a synced product comes from and what the next sync replaces. */
function SyncedNote({ orgId, product }: { orgId: string; product: Product }) {
  const sources = useCatalogSources(orgId, Boolean(product.sync));
  if (!product.sync) return null;
  const source = sources.data?.find((s) => s.id === product.sync!.sourceId);
  return (
    <Alert
      tone="info"
      className="mb-4"
      title={
        <span className="inline-flex items-center gap-1.5">
          <RefreshCw className="size-3.5" aria-hidden /> Synced from {source?.name ?? 'a source'}
        </span>
      }
      action={
        <Button asChild size="sm" variant="outline">
          <Link href={`/app/${orgId}/products/sync`}>Import and sync</Link>
        </Button>
      }
    >
      Last synced {formatRelative(product.sync.syncedAt)}. When this product changes at the source,
      its{' '}
      {source?.syncStock === false
        ? 'name, description, prices, options and photos'
        : 'name, description, prices, options, photos and stock'}{' '}
      are replaced here. Your costs are kept.
      {product.sync.archivedBySync && ' It was archived because the source no longer lists it.'}
    </Alert>
  );
}

export default function ProductPage() {
  const { org, can } = useOrg();
  const { productId } = useParams<{ productId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const settings = useShopSettings(org.id);
  const [adjusting, setAdjusting] = useState<Variant | null>(null);
  const [removing, setRemoving] = useState(false);
  const key = commerceKeys.product(org.id, productId);
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<Product>(`/orgs/${org.id}/products/${productId}`),
  });

  const saved = (p: Product) => {
    queryClient.setQueryData(key, p);
    void queryClient.invalidateQueries({ queryKey: commerceKeys.products(org.id) });
    void queryClient.invalidateQueries({ queryKey: commerceKeys.stock(org.id, p.id) });
  };

  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.isError) return <PageError error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const threshold = settings.data?.lowStockThreshold ?? 3;
  const tracked = p.variants.filter((v) => v.trackStock);

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link href={`/app/${org.id}/products`}>
          <ArrowLeft /> Products
        </Link>
      </Button>
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {p.name} <ProductStatusBadge status={p.status} />
          </span>
        }
        description={`${p.soldCount} sold`}
        actions={
          can('catalog.manage') && (
            <Button variant="outline" onClick={() => setRemoving(true)}>
              <Trash2 /> {p.soldCount > 0 ? 'Archive' : 'Delete'}
            </Button>
          )
        }
      />
      <SyncedNote orgId={org.id} product={p} />
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_320px]">
        {/* key: reset the form state when the product is saved from another tab of this page */}
        <ProductForm
          key={p.updatedAt}
          product={p}
          onSaved={(saved_) => {
            saved(saved_);
            toast.success('Saved.');
          }}
        />
        <div className="grid gap-6 lg:sticky lg:top-20">
          <Card>
            <CardHeader>
              <CardTitle>Stock</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-2">
              {tracked.length === 0 ? (
                <p className="px-5 pb-3 text-sm text-muted-foreground">
                  Stock is not tracked for this product. Turn on “Track stock” to count it.
                </p>
              ) : (
                <ul className="divide-y text-sm">
                  {tracked.map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-3 px-5 py-2">
                      <span className="min-w-0 truncate">
                        {v.title === 'Default' ? 'In stock' : v.title}
                      </span>
                      <span className="flex items-center gap-2">
                        <StockBadge tracked stock={v.stock} threshold={threshold} />
                        {can('inventory.manage') && (
                          <Button variant="ghost" size="sm" onClick={() => setAdjusting(v)}>
                            Change
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <StockHistory orgId={org.id} product={p} timezone={org.timezone} />
        </div>
      </div>

      <StockAdjustDialog
        orgId={org.id}
        product={p}
        variant={adjusting}
        onOpenChange={(o) => !o && setAdjusting(null)}
        onSaved={(updated) => {
          saved(updated);
          toast.success('Stock updated.');
        }}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        destructive
        title={p.soldCount > 0 ? `Archive ${p.name}?` : `Delete ${p.name}?`}
        description="Products that are on any order are archived instead of deleted, so past orders and invoices stay correct. Archived products are hidden from lists and cannot be ordered."
        confirmLabel="Continue"
        onConfirm={async () => {
          try {
            const r = await api<{ deleted: boolean; archived: boolean }>(
              `/orgs/${org.id}/products/${p.id}`,
              { method: 'DELETE' },
            );
            await queryClient.invalidateQueries({ queryKey: commerceKeys.products(org.id) });
            toast.success(r.deleted ? 'Product deleted.' : 'Product archived.');
            router.push(`/app/${org.id}/products`);
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </>
  );
}
