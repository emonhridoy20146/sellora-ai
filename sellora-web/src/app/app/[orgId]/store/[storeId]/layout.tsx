'use client';

import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { useStore } from '@/components/stores/hooks';
import { PreviewButton } from '@/components/stores/preview-button';
import { StoreStatusBadge } from '@/components/stores/store-status';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { TabNav } from '@/components/ui/tab-nav';

export default function StoreEditorLayout({ children }: { children: React.ReactNode }) {
  const { org } = useOrg();
  const { storeId } = useParams<{ storeId: string }>();
  const store = useStore(org.id, storeId);
  const base = `/app/${org.id}/store/${storeId}`;

  if (store.isPending) return <Skeleton className="h-96" />;
  if (store.isError) return <PageError error={store.error} onRetry={() => void store.refetch()} />;
  const s = store.data;
  const open = s.status === 'live' || s.status === 'paused';

  return (
    <>
      <Link
        href={`/app/${org.id}/store`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Online store
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.name} <StoreStatusBadge status={s.status} />
          </span>
        }
        description={<span className="break-all">{s.primaryDomain ?? s.host}</span>}
        actions={
          <>
            <PreviewButton orgId={org.id} storeId={s.id} />
            {open && (
              <Button asChild variant="outline">
                <a href={s.url} target="_blank" rel="noreferrer">
                  <ExternalLink /> Visit store
                </a>
              </Button>
            )}
          </>
        }
      />
      <TabNav
        tabs={[
          { href: base, label: 'Overview', exact: true },
          { href: `${base}/numbers`, label: 'Numbers' },
          { href: `${base}/design`, label: 'Design' },
          { href: `${base}/details`, label: 'Details' },
          { href: `${base}/pages`, label: 'Pages' },
          { href: `${base}/domain`, label: 'Web address' },
        ]}
      />
      {children}
    </>
  );
}
