'use client';

import { ExternalLink, Palette, Plus, Send, Store as StoreIcon } from 'lucide-react';
import Link from 'next/link';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { useStores } from '@/components/stores/hooks';
import { StoreStatusBadge } from '@/components/stores/store-status';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/format';
import { STORE_STATUS } from '@/lib/stores';

const STEPS = [
  { icon: Palette, title: 'Pick a look', text: 'Choose a theme made for your kind of business.' },
  {
    icon: StoreIcon,
    title: 'Make it yours',
    text: 'Add your logo, pictures, contact number and policies.',
  },
  {
    icon: Send,
    title: 'Send for review',
    text: 'Sellora checks the store, then shoppers can order with cash on delivery.',
  },
];

export default function StoresPage() {
  const { org, can } = useOrg();
  const stores = useStores(org.id);
  const base = `/app/${org.id}/store`;
  const full = stores.data && stores.data.limit !== null && stores.data.used >= stores.data.limit;
  const createButton = can('stores.manage') && !full && (
    <Button asChild>
      <Link href={`${base}/new`}>
        <Plus /> Create store
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Online store"
        description="Your own shop on the web: shoppers browse your products and order with cash on delivery. Orders arrive in Orders like any other."
        actions={stores.data?.items.length ? createButton : undefined}
      />
      {stores.isPending ? (
        <Skeleton className="h-48" />
      ) : stores.isError ? (
        <PageError error={stores.error} onRetry={() => void stores.refetch()} />
      ) : stores.data.items.length === 0 ? (
        <Card>
          <CardContent className="grid gap-6 py-8">
            <div className="text-center">
              <h2 className="text-lg font-semibold">Open your online store</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                It takes a few minutes. Your products, prices and stock are already here.
              </p>
            </div>
            <ol className="grid gap-4 sm:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="rounded-lg border p-4">
                  <s.icon className="mb-2 size-5 text-primary" aria-hidden />
                  <p className="font-medium">
                    {i + 1}. {s.title}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
                </li>
              ))}
            </ol>
            <div className="flex justify-center">
              {createButton || (
                <p className="text-sm text-muted-foreground">
                  Ask the owner or an admin to create the store.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {full && (
            <p className="text-sm text-muted-foreground">
              Your plan allows {stores.data.limit} store{stores.data.limit === 1 ? '' : 's'}.{' '}
              {can('billing.view') && (
                <Link href={`/app/${org.id}/billing/plans`} className="text-primary underline">
                  Change plan
                </Link>
              )}
            </p>
          )}
          {stores.data.items.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex flex-wrap items-center gap-4 py-4">
                <span
                  aria-hidden
                  className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md text-lg font-semibold text-white"
                  style={{ background: s.theme.palette.primary }}
                >
                  {s.theme.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.theme.logo.url} alt="" className="size-full object-cover" />
                  ) : (
                    s.name.slice(0, 1).toUpperCase()
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`${base}/${s.id}`} className="font-medium hover:underline">
                      {s.name}
                    </Link>
                    <StoreStatusBadge status={s.status} />
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{s.host}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.status === 'live' && s.liveSince
                      ? `Open since ${formatDate(s.liveSince)}`
                      : STORE_STATUS[s.status].text}
                  </p>
                </div>
                <div className="flex gap-2">
                  {(s.status === 'live' || s.status === 'paused') && (
                    <Button asChild variant="outline" size="sm">
                      <a href={s.url} target="_blank" rel="noreferrer">
                        <ExternalLink /> Visit
                      </a>
                    </Button>
                  )}
                  <Button asChild size="sm">
                    <Link href={`${base}/${s.id}`}>Manage</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
