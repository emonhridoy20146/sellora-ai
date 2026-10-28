'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CircleCheck, ExternalLink, Eye, Flag, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ProductThumb } from '@/components/commerce/product-thumb';
import { LandingStatusBadge } from '@/components/landing/status';
import { usePlatform } from '@/components/platform-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  LandingContent,
  LandingStatus,
  PlatformLandingDetail,
  StoreReviewFlag,
} from '@/lib/api/types';
import { formatDateTime, formatMoney, humanize } from '@/lib/format';
import {
  HIDE_ON_LABEL,
  LANDING_SECTION_LABEL,
  landingSectionSummary,
  sectionWords,
} from '@/lib/landing';

type Decision = 'approve' | 'reject' | 'takedown' | 'reinstate';
type Shown = 'submission' | 'published';

/** Each status as the reviewer reads it (the merchant's wording is in LANDING_STATUS). */
const REVIEWER_TEXT: Record<LandingStatus, string> = {
  draft: 'Never sent for review. Shoppers cannot see it.',
  in_review: 'Waiting for a decision. Open the preview, read the words and the offer, then decide.',
  changes_requested: 'Sent back for changes. It returns here when the business publishes again.',
  live: 'Shoppers can see it and order.',
  paused:
    'Paused by the business (or its store is paused). Shoppers see that the offer is not available.',
  taken_down: 'Taken down by the platform. Shoppers see that the page is unavailable.',
};

const DECISION: Record<
  Decision,
  { label: string; title: string; text: string; reason?: string; destructive?: boolean }
> = {
  approve: {
    label: 'Approve and publish',
    title: 'Publish this version?',
    text: 'Shoppers see exactly the version you looked at, at once, and the owner gets an email. If the business sent a newer version meanwhile, nothing is published.',
  },
  reject: {
    label: 'Ask for changes',
    title: 'Send this version back?',
    text: 'The owner reads your note in the dashboard and by email. A version already live stays live.',
    reason: 'What needs to change (the owner sees this)',
    destructive: true,
  },
  takedown: {
    label: 'Take page down',
    title: 'Take this page down?',
    text: 'Shoppers see that the page is unavailable and cannot order from it. A version waiting for review is sent back with the same note. Only the platform can put the page back.',
    reason: 'Why (the owner sees this)',
    destructive: true,
  },
  reinstate: {
    label: 'Put page back',
    title: 'Put this page back?',
    text: 'The last approved version shows again, unless the business has paused the page.',
  },
};

const DONE: Record<Decision, string> = {
  approve: 'Published. The owner has been told.',
  reject: 'Sent back to the owner.',
  takedown: 'Page taken down. The owner has been told.',
  reinstate: 'Page put back. The owner has been told.',
};

function FlagList({ flags }: { flags: StoreReviewFlag[] }) {
  return (
    <ul className="grid gap-2">
      {flags.map((f, i) => (
        <li key={`${f.where}-${f.term}-${i}`} className="rounded-md border bg-card p-3 text-sm">
          <span className="font-medium">{f.label}</span>
          <span className="text-muted-foreground"> contains </span>
          <span className="rounded bg-warning-soft px-1 font-mono text-[13px]">{f.term}</span>
          <span className="block text-xs text-muted-foreground">{f.reason}</span>
        </li>
      ))}
    </ul>
  );
}

function Offer({ p, content }: { p: PlatformLandingDetail; content: LandingContent }) {
  const main = p.products.find((x) => x.role === 'main');
  const addOn = p.products.find((x) => x.role === 'add_on');
  const currency = p.org?.currency ?? main?.currency ?? addOn?.currency;
  const money = (minor: number) => (currency ? formatMoney(minor, currency) : String(minor));
  return (
    <div className="grid gap-4 text-sm">
      {p.products.length === 0 && (
        <p className="text-muted-foreground">The product this page sold no longer exists.</p>
      )}
      {[main, addOn].filter(Boolean).map((x) => (
        <div key={x!.id} className="flex items-start gap-3 rounded-md border p-3">
          <ProductThumb url={x!.image ?? undefined} className="size-12" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {x!.name}{' '}
              <span className="font-normal text-muted-foreground">
                {x!.role === 'main' ? '(the product)' : '(add-on)'}
              </span>
            </p>
            <p className="text-muted-foreground">
              From {formatMoney(x!.priceMinor, x!.currency)}
              {x!.status !== 'active' && (
                <span className="ml-2 text-warning">Not on sale ({humanize(x!.status)})</span>
              )}
            </p>
            {x!.description && (
              <p className="mt-1 line-clamp-3 text-muted-foreground">{x!.description}</p>
            )}
          </div>
        </div>
      ))}
      {content.offer.packages.length > 0 && (
        <div className="grid gap-1.5">
          <p className="font-medium">Packages</p>
          <ul className="grid gap-1">
            {content.offer.packages.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-2">
                <span>{k.label}</span>
                <span className="text-muted-foreground">× {k.quantity}</span>
                <span className="tabular">
                  {k.priceMinor === null
                    ? main
                      ? `${money(main.priceMinor * k.quantity)} (regular price)`
                      : 'Regular price'
                    : money(k.priceMinor)}
                </span>
                {k.badge && <Badge tone="info">{k.badge}</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {content.offer.addOn && (
        <p>
          <span className="font-medium">Add-on:</span> {content.offer.addOn.label} for{' '}
          {money(content.offer.addOn.priceMinor)}
          {addOn && addOn.priceMinor > content.offer.addOn.priceMinor && (
            <span className="text-muted-foreground"> (usually {money(addOn.priceMinor)})</span>
          )}
        </p>
      )}
    </div>
  );
}

function Contents({ content }: { content: LandingContent }) {
  const shown = content.sections.filter((s) => s.enabled);
  return (
    <div className="grid gap-4 text-sm">
      <ol className="grid gap-2">
        {shown.map((s, i) => {
          const words = sectionWords(s);
          return (
            <li key={s.id}>
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer">
                  <span className="text-muted-foreground">
                    {i + 1}. {LANDING_SECTION_LABEL[s.type]}:{' '}
                  </span>
                  <span className="font-medium">{landingSectionSummary(s)}</span>
                  {s.hideOn !== 'none' && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {HIDE_ON_LABEL[s.hideOn]}
                    </span>
                  )}
                </summary>
                {words.length ? (
                  <dl className="mt-2 grid gap-1.5">
                    {words.map((w) => (
                      <div key={w.key} className="grid gap-0.5 sm:grid-cols-[180px_1fr] sm:gap-3">
                        <dt className="text-muted-foreground">{w.key}</dt>
                        <dd className="min-w-0 break-words whitespace-pre-line">{w.text}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="mt-2 text-muted-foreground">No words of its own.</p>
                )}
              </details>
            </li>
          );
        })}
        {shown.length === 0 && <li className="text-muted-foreground">No sections shown.</li>}
      </ol>
      <dl className="grid gap-1.5 border-t pt-3">
        <div className="grid gap-0.5 sm:grid-cols-[180px_1fr] sm:gap-3">
          <dt className="text-muted-foreground">Search title</dt>
          <dd>{content.seo.title || '–'}</dd>
        </div>
        <div className="grid gap-0.5 sm:grid-cols-[180px_1fr] sm:gap-3">
          <dt className="text-muted-foreground">Search description</dt>
          <dd>{content.seo.description || '–'}</dd>
        </div>
        <div className="grid gap-0.5 sm:grid-cols-[180px_1fr] sm:gap-3">
          <dt className="text-muted-foreground">Search engines</dt>
          <dd>{content.seo.index ? 'May list it' : 'Asked not to list it'}</dd>
        </div>
      </dl>
    </div>
  );
}

export default function PlatformLandingPage() {
  const { pageId } = useParams<{ pageId: string }>();
  const { can } = usePlatform();
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const key = ['platform', 'landing-pages', 'detail', pageId];
  const detail = useQuery({
    queryKey: key,
    queryFn: () => api<PlatformLandingDetail>(`/platform/landing-pages/${pageId}`),
  });

  if (detail.isPending) return <Skeleton className="h-96" />;
  if (detail.isError)
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  const p = detail.data;
  const editable = can('platform.stores.approve');
  const pending = p.submission?.status === 'pending';
  const view: Shown = shown ?? (pending && p.submissionContent ? 'submission' : 'published');
  const content = view === 'submission' ? p.submissionContent : p.publishedContent;
  const decisions: Decision[] = p.takedown
    ? ['reinstate']
    : pending
      ? ['approve', 'reject', 'takedown']
      : p.published
        ? ['takedown']
        : [];

  const decide = async (d: Decision, reason: string) => {
    const body =
      d === 'approve'
        ? { revision: p.submission!.revision }
        : d === 'reject'
          ? { revision: p.submission!.revision, reason }
          : d === 'takedown'
            ? { reason }
            : undefined;
    try {
      const next = await api<PlatformLandingDetail>(`/platform/landing-pages/${pageId}/${d}`, {
        method: 'POST',
        body,
      });
      queryClient.setQueryData(key, next);
      setShown(null);
      void queryClient.invalidateQueries({ queryKey: ['platform', 'landing-pages'] });
      toast.success(DONE[d]);
    } catch (err) {
      toast.error(errorMessage(err));
      // Someone else decided, or the business sent a newer version: show what is there now.
      if (err instanceof ApiError && err.status === 409) {
        setDecision(null);
        void detail.refetch();
        return;
      }
      throw err;
    }
  };

  return (
    <>
      <Link
        href="/admin/landing-pages"
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
          <>
            {p.org ? (
              <Link href={`/admin/tenants/${p.org.id}`} className="text-primary hover:underline">
                {p.org.name}
              </Link>
            ) : (
              'Unknown business'
            )}{' '}
            · <span className="break-all">{p.url ?? `/${p.slug}`}</span>
          </>
        }
        actions={
          <>
            {p.preview && (
              <Button asChild variant="outline">
                <a href={p.preview.url} target="_blank" rel="noreferrer">
                  <Eye /> Open preview
                </a>
              </Button>
            )}
            {p.status === 'live' && p.url && (
              <Button asChild variant="outline">
                <a href={p.url} target="_blank" rel="noreferrer">
                  <ExternalLink /> Open live page
                </a>
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="grid min-w-0 content-start gap-6">
          {p.submission && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Flag className="size-4" aria-hidden /> Automatic check
                </CardTitle>
                <CardDescription>
                  Words often used for banned or misleading products, found in the version sent on{' '}
                  {formatDateTime(p.submission.submittedAt)}. A warning is a reason to look, not a
                  verdict.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {p.submission.flags.length ? (
                  <FlagList flags={p.submission.flags} />
                ) : (
                  <p className="flex items-center gap-2 text-sm text-success">
                    <CircleCheck className="size-4" aria-hidden /> No warnings.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {p.submissionContent && p.publishedContent && (
            <Segmented<Shown>
              label="Version"
              value={view}
              onChange={setShown}
              options={[
                {
                  value: 'submission',
                  label: pending ? 'Sent for review' : 'Last version sent',
                },
                { value: 'published', label: p.takedown ? 'Approved before' : 'Live now' },
              ]}
            />
          )}

          {content ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>What it sells</CardTitle>
                  <CardDescription>
                    Shoppers pay cash on delivery. Prices on the page are checked against these when
                    an order comes in.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Offer p={p} content={content} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Words on the page</CardTitle>
                  <CardDescription>
                    Shown sections from top to bottom. Open one to read everything it says.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Contents content={content} />
                </CardContent>
              </Card>
            </>
          ) : (
            <Alert tone="info">
              The business has not sent this page for review yet, so there is nothing to read.
            </Alert>
          )}
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Decision</CardTitle>
              <CardDescription>{REVIEWER_TEXT[p.status]}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {p.store && (
                <p>
                  Store{' '}
                  <Link
                    href={`/admin/stores/${p.store.id}`}
                    className="text-primary hover:underline"
                  >
                    {p.store.name}
                  </Link>{' '}
                  <span className="text-muted-foreground">({humanize(p.store.status)})</span>
                </p>
              )}
              {p.store?.status === 'suspended' && (
                <p className="flex items-start gap-2 text-warning">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> The store is
                  suspended, so the page cannot show either way.
                </p>
              )}
              {p.submission && (
                <p className="text-muted-foreground">
                  {pending ? 'Sent' : 'Last sent'} {formatDateTime(p.submission.submittedAt)}
                  {pending && p.published ? ', as changes to the live page' : ''}.
                </p>
              )}
              {p.published && (
                <p className="text-muted-foreground">
                  Version {p.published.version} published {formatDateTime(p.published.publishedAt)}
                  {p.published.autoApproved ? ' (without review)' : ''}.
                </p>
              )}
              {p.paused && <p className="text-muted-foreground">The business paused the page.</p>}
              {p.takedown && (
                <Alert tone="danger" title={`Taken down ${formatDateTime(p.takedown.at)}`}>
                  {p.takedown.reason}
                </Alert>
              )}
              {!p.takedown && p.submission?.status === 'rejected' && p.submission.reason && (
                <Alert tone="warning" title="Note to the owner">
                  {p.submission.reason}
                </Alert>
              )}
              {editable && decisions.length > 0 && (
                <div className="grid gap-2 pt-1">
                  {decisions.map((d) => (
                    <Button
                      key={d}
                      variant={d === 'approve' || d === 'reinstate' ? 'default' : 'outline'}
                      className={d === 'takedown' ? 'text-destructive' : undefined}
                      onClick={() => setDecision(d)}
                    >
                      {DECISION[d].label}
                    </Button>
                  ))}
                </div>
              )}
              {pending && view === 'published' && (
                <p className="text-xs text-muted-foreground">
                  You are looking at the live version. Approving publishes the version sent for
                  review.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={decision !== null}
        onOpenChange={(o) => !o && setDecision(null)}
        title={decision ? DECISION[decision].title : ''}
        description={decision ? DECISION[decision].text : undefined}
        confirmLabel={decision ? DECISION[decision].label : 'Confirm'}
        destructive={decision ? DECISION[decision].destructive : false}
        reason={Boolean(decision && DECISION[decision].reason)}
        reasonLabel={decision ? DECISION[decision].reason : undefined}
        reasonMin={5}
        onConfirm={(reason) => (decision ? decide(decision, reason) : undefined)}
      />
    </>
  );
}
