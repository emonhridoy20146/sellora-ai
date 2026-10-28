'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Copy,
  Ellipsis,
  ExternalLink,
  Pause,
  Play,
  ShoppingBag,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageError } from '@/components/commerce/page-error';
import { landingKeys, useLandingPage } from '@/components/landing/hooks';
import { LandingPreviewButton } from '@/components/landing/preview-button';
import { LandingStatusBadge } from '@/components/landing/status';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { TabNav } from '@/components/ui/tab-nav';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { LandingPage } from '@/lib/api/types';
import { formatRelative } from '@/lib/format';
import { LANDING_STATUS } from '@/lib/landing';

/** What the business should know about where the page stands, beyond the badge. */
function StatusNote({ page }: { page: LandingPage }) {
  const sub = page.submission;
  if (page.takedown)
    return (
      <Alert tone="danger" title="Sellora took this page down">
        <p>{page.takedown.reason}</p>
        <p className="mt-1">
          {sub?.status === 'pending'
            ? 'Your fixed version is waiting for review.'
            : 'Fix the page and publish it again; it goes back up once approved.'}
        </p>
      </Alert>
    );
  if (sub?.status === 'rejected')
    return (
      <Alert tone="danger" title="Changes needed before this version can go live">
        <p>{sub.reason}</p>
        {page.published && (
          <p className="mt-1">The version approved before stays live in the meantime.</p>
        )}
      </Alert>
    );
  if (sub?.status === 'pending')
    return (
      <Alert tone="warning" title="Waiting for review">
        <p>
          Sent {formatRelative(sub.submittedAt)}.{' '}
          {page.published
            ? 'Shoppers keep seeing the live version until this one is approved.'
            : 'You get an email when it goes live.'}
          {sub.revision !== page.revision &&
            ' You have changed the page since sending it; publish again to send the newer version.'}
        </p>
      </Alert>
    );
  if (page.status === 'live' && page.hasUnpublishedChanges)
    return (
      <Alert tone="info">
        You have saved changes shoppers do not see yet. Publish to send them for review.
      </Alert>
    );
  if (page.store?.status === 'paused' && page.status === 'live')
    return <Alert tone="warning">The store is paused, so this page is paused too.</Alert>;
  return null;
}

export default function LandingPageLayout({ children }: { children: React.ReactNode }) {
  const { org, can } = useOrg();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { pageId } = useParams<{ pageId: string }>();
  const page = useLandingPage(org.id, pageId);
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/app/${org.id}/landing-pages/${pageId}`;

  if (page.isPending) return <Skeleton className="h-96" />;
  if (page.isError) return <PageError error={page.error} onRetry={() => void page.refetch()} />;
  const p = page.data;
  const publisher = can('stores.publish');

  const act = (action: 'pause' | 'resume' | 'withdraw', done: string) => {
    setBusy(action);
    api<LandingPage>(`/orgs/${org.id}/landing-pages/${p.id}/${action}`, { method: 'POST' })
      .then((next) => {
        queryClient.setQueryData(landingKeys.page(org.id, p.id), next);
        void queryClient.invalidateQueries({ queryKey: landingKeys.all(org.id), exact: true });
        toast.success(done);
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => setBusy(null));
  };
  const duplicate = () => {
    setBusy('duplicate');
    api<LandingPage>(`/orgs/${org.id}/landing-pages/${p.id}/duplicate`, { body: {} })
      .then((copy) => {
        queryClient.setQueryData(landingKeys.page(org.id, copy.id), copy);
        void queryClient.invalidateQueries({ queryKey: landingKeys.all(org.id), exact: true });
        toast.success('Copied as a new draft.');
        router.push(`/app/${org.id}/landing-pages/${copy.id}`);
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => setBusy(null));
  };

  return (
    <>
      <Link
        href={`/app/${org.id}/landing-pages`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Landing pages
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {p.name} <LandingStatusBadge status={p.status} />
          </span>
        }
        description={
          <span className="break-all">
            {p.url ?? `/${p.slug}`} · {LANDING_STATUS[p.status].text}
          </span>
        }
        actions={
          <>
            <LandingPreviewButton orgId={org.id} pageId={p.id} />
            {p.status === 'live' && p.url && (
              <Button asChild variant="outline">
                <a href={p.url} target="_blank" rel="noreferrer">
                  <ExternalLink /> Open page
                </a>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="More actions"
                  loading={busy !== null}
                >
                  {busy === null && <Ellipsis />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {can('orders.view') && (
                  <DropdownMenuItem asChild>
                    <Link href={`/app/${org.id}/orders?landingPageId=${p.id}`}>
                      <ShoppingBag /> Orders from this page
                    </Link>
                  </DropdownMenuItem>
                )}
                {publisher && p.status === 'live' && (
                  <DropdownMenuItem
                    onSelect={() =>
                      act('pause', 'Paused. Shoppers see that the offer is not available.')
                    }
                  >
                    <Pause /> Pause page
                  </DropdownMenuItem>
                )}
                {publisher && p.status === 'paused' && p.paused && (
                  <DropdownMenuItem onSelect={() => act('resume', 'The page is live again.')}>
                    <Play /> Resume page
                  </DropdownMenuItem>
                )}
                {publisher && p.submission?.status === 'pending' && (
                  <DropdownMenuItem onSelect={() => act('withdraw', 'Taken back from review.')}>
                    <Undo2 /> Take back from review
                  </DropdownMenuItem>
                )}
                {can('stores.manage') && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={duplicate}>
                      <Copy /> Duplicate
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <div className="mb-6 empty:hidden">
        <StatusNote page={p} />
      </div>
      <TabNav
        tabs={[
          { href: base, label: 'Editor', exact: true },
          { href: `${base}/stats`, label: 'Numbers' },
          { href: `${base}/versions`, label: 'Versions' },
          { href: `${base}/settings`, label: 'Settings' },
        ]}
      />
      {children}
    </>
  );
}
