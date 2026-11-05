'use client';

import { Plus } from 'lucide-react';
import { useCallback, useState } from 'react';
import { AddSourceDialog } from '@/components/catalog-sync/add-source';
import { KIND_ICON, KIND_INFO, useCatalogSources } from '@/components/catalog-sync/shared';
import { SourceCard } from '@/components/catalog-sync/source-card';
import { PageError } from '@/components/commerce/page-error';
import { ProductsTabs } from '@/components/commerce/products-tabs';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import type { CatalogSourceKind } from '@/lib/api/types';

export default function CatalogSyncPage() {
  const { org, can } = useOrg();
  const manage = can('catalog.manage');
  const sources = useCatalogSources(org.id);
  const [adding, setAdding] = useState<{ kind: CatalogSourceKind | null } | null>(null);
  const [watch, setWatch] = useState<Record<string, string | null>>({});
  const watchFor = useCallback(
    (sourceId: string) => (runId: string | null) => setWatch((w) => ({ ...w, [sourceId]: runId })),
    [],
  );
  const list = sources.data ?? [];

  return (
    <>
      <PageHeader
        title="Products"
        description="Bring products in from Shopify, WooCommerce, a Google Sheet, a CSV file or your own website, and keep them up to date."
        actions={
          manage &&
          list.length > 0 && (
            <Button onClick={() => setAdding({ kind: null })}>
              <Plus /> Add source
            </Button>
          )
        }
      />
      <ProductsTabs orgId={org.id} />
      {sources.isPending ? (
        <Skeleton className="h-40" />
      ) : sources.isError ? (
        <PageError error={sources.error} onRetry={() => void sources.refetch()} />
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="grid gap-4 py-6">
            <div>
              <p className="font-medium">Already sell somewhere else?</p>
              <p className="text-sm text-muted-foreground">
                Connect it once and Sellora keeps prices, stock and photos the same, so the AI sales
                agent never quotes an old price. You see what will be imported before anything is
                added.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(Object.keys(KIND_INFO) as CatalogSourceKind[]).map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={!manage}
                    onClick={() => setAdding({ kind: k })}
                    className="flex flex-col gap-1 rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent disabled:pointer-events-none disabled:opacity-60"
                  >
                    <Icon className="mb-1 size-5 text-primary" aria-hidden />
                    <span className="font-medium">{KIND_INFO[k].label}</span>
                    <span className="text-[13px] text-muted-foreground">{KIND_INFO[k].blurb}</span>
                  </button>
                );
              })}
            </div>
            {!manage && (
              <p className="text-[13px] text-muted-foreground">
                Ask the owner or a manager to connect a source.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          {list.map((s) => (
            <SourceCard
              key={s.id}
              orgId={org.id}
              source={s}
              manage={manage}
              watchRunId={watch[s.id] ?? null}
              onWatch={watchFor(s.id)}
            />
          ))}
          <p className="text-[13px] text-muted-foreground">
            Synced products can be edited here too, but the next change at the source replaces their
            name, description, prices, options and photos (and stock, if it is synced). Costs you
            enter in Sellora are kept.
          </p>
        </div>
      )}
      {adding && (
        <AddSourceDialog
          key={adding.kind ?? 'any'}
          orgId={org.id}
          open
          initialKind={adding.kind}
          onOpenChange={(o) => !o && setAdding(null)}
          onAdded={(source, runId) => setWatch((w) => ({ ...w, [source.id]: runId }))}
        />
      )}
    </>
  );
}
