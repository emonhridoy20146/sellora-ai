'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ExternalLink, FileText, Search, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type {
  CatalogSource,
  HeldChange,
  Page,
  WebsitePage,
  WebsiteSearchHit,
} from '@/lib/api/types';
import { formatDateTime, formatMoney, formatNumber, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { syncKeys } from './shared';

/**
 * The website parts of a source card (ADR 0024): proving the site is the business's own, the
 * large changes that wait for the merchant, and the pages the AI answers from.
 */

/** The DNS label the TXT record goes under, relative to the domain. */
const VERIFY_LABEL = '_sellora-verify';

function Copyable({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <code className="min-w-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
        {value}
      </code>
      <CopyButton value={value} ariaLabel={`Copy the ${label}`} />
    </div>
  );
}

/** Shown on a website source until its ownership is proven, and again when the proof is lost. */
export function VerifyPanel({
  orgId,
  source,
  manage,
  onStarted,
}: {
  orgId: string;
  source: CatalogSource;
  manage: boolean;
  onStarted: (runId: string | null) => void;
}) {
  const w = source.website!;
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lost = Boolean(source.lastRun);
  const shown = error ?? w.verifyError;

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ source: CatalogSource; runId: string | null }>(
        `/orgs/${orgId}/catalog-sources/${source.id}/verify`,
        { method: 'POST' },
      );
      await queryClient.invalidateQueries({ queryKey: syncKeys.sources(orgId) });
      toast.success(`${w.host} is verified. Reading the site now.`);
      onStarted(res.runId);
    } catch (err) {
      setError(errorMessage(err));
      void queryClient.invalidateQueries({ queryKey: syncKeys.sources(orgId) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby={`verify-${source.id}`}
      className="grid gap-3 rounded-lg border border-warning/40 bg-warning-soft/40 p-4"
      data-testid="verify-panel"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
        <div>
          <h3 id={`verify-${source.id}`} className="font-medium">
            {lost ? 'Prove again that the site is yours' : 'Prove that the site is yours'}
          </h3>
          <p className="text-[13px] text-muted-foreground">
            {lost
              ? 'The proof was not found when the site was last read, so reading stopped. Products and pages already read stay as they are.'
              : 'Sellora reads a website only for the business that owns it. Do one of these, then press Verify. Nothing beyond the home page is read until then.'}
          </p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="grid content-start gap-2 rounded-md border bg-card p-3">
          <p className="text-sm font-medium">Add a DNS record</p>
          <p className="text-[13px] text-muted-foreground">
            Where you manage the domain, add a TXT record. It can take up to an hour to show.
          </p>
          <dl className="grid gap-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Type</dt>
              <dd className="font-mono text-xs">TXT</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Name / Host</dt>
              <dd>
                <Copyable value={VERIFY_LABEL} label="record name" />
                <span className="mt-1 block text-xs break-all text-muted-foreground">
                  Some providers want the full name: {w.dnsName}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Value</dt>
              <dd>
                <Copyable value={w.dnsValue} label="record value" />
              </dd>
            </div>
          </dl>
        </div>
        <div className="grid content-start gap-2 rounded-md border bg-card p-3">
          <p className="text-sm font-medium">Or add a tag to the home page</p>
          <p className="text-[13px] text-muted-foreground">
            Paste it inside the &lt;head&gt; of the home page. Most shop builders have a place for
            it under SEO or custom code.
          </p>
          <Copyable value={w.metaTag} label="verification tag" />
        </div>
      </div>
      {shown && (
        <Alert tone="danger" title="Not verified yet">
          {shown}
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {manage ? (
          <Button size="sm" onClick={() => void verify()} disabled={busy}>
            <ShieldCheck /> {busy ? 'Checking…' : 'Verify'}
          </Button>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Ask the owner or a manager to verify the site.
          </p>
        )}
        {w.checkedAt && (
          <span className="text-xs text-muted-foreground" title={formatDateTime(w.checkedAt)}>
            Last checked {formatRelative(w.checkedAt)}
          </span>
        )}
      </div>
    </section>
  );
}

function HeldEntry({
  orgId,
  currency,
  change: h,
  manage,
  busy,
  onDecide,
}: {
  orgId: string;
  currency: string;
  change: HeldChange;
  manage: boolean;
  busy: boolean;
  onDecide: (decision: 'apply' | 'keep') => void;
}) {
  const pending = h.decision === 'pending';
  return (
    <li className="grid gap-2 px-4 py-3" data-testid={`held-${h.ref}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {h.kind === 'price' ? (
              h.productId ? (
                <Link
                  href={`/app/${orgId}/products/${h.productId}`}
                  className="underline-offset-2 hover:underline"
                >
                  {h.label}
                </Link>
              ) : (
                h.label
              )
            ) : (
              `${h.label} are gone from the source`
            )}
          </p>
          <p className="text-xs text-muted-foreground" title={formatDateTime(h.seenAt)}>
            {h.kind === 'price' ? 'Price changed by more than half' : 'More than half at once'} ·
            seen {formatRelative(h.seenAt)}
          </p>
        </div>
        {!pending && (
          <Badge tone={h.decision === 'apply' ? 'info' : 'neutral'}>
            {h.decision === 'apply' ? 'Applied on the next sync' : 'Kept as it is in Sellora'}
          </Badge>
        )}
      </div>
      {h.kind === 'price' ? (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Variant
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                In Sellora
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                At the source
              </th>
            </tr>
          </thead>
          <tbody>
            {h.prices.map((p) => (
              <tr key={p.variant} className="border-t">
                <td className="py-1">{p.variant || 'Price'}</td>
                <td className="tabular py-1 text-right">{formatMoney(p.fromMinor, currency)}</td>
                <td className="tabular py-1 text-right font-medium">
                  {formatMoney(p.toMinor, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {h.names.join(', ')}
          {Number(h.label.split(' ')[0]) > h.names.length ? ', …' : ''}
        </p>
      )}
      {pending && manage && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => onDecide('apply')}>
            {h.kind === 'price' ? 'Apply the new price' : 'Archive them'}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide('keep')}>
            {h.kind === 'price' ? 'Keep Sellora’s price' : 'Keep them'}
          </Button>
        </div>
      )}
    </li>
  );
}

/** Large changes at the source that wait for the merchant to apply or keep. */
export function HeldDialog({
  orgId,
  currency,
  source,
  manage,
  open,
  onOpenChange,
  onStarted,
}: {
  orgId: string;
  currency: string;
  source: CatalogSource;
  manage: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onStarted: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (h: HeldChange, decision: 'apply' | 'keep') => {
    setBusy(h.ref);
    try {
      const res = await api<{ source: CatalogSource; runId: string | null }>(
        `/orgs/${orgId}/catalog-sources/${source.id}/held`,
        { body: { ref: h.ref, decision } },
      );
      await queryClient.invalidateQueries({ queryKey: syncKeys.sources(orgId) });
      if (decision === 'keep') toast.success('Kept. Sellora keeps its version.');
      else toast.success(res.runId ? 'Applying it now.' : 'It is applied on the next sync.');
      if (res.runId) onStarted(res.runId);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const items = [...source.held].sort(
    (a, b) => Number(b.decision === 'pending') - Number(a.decision === 'pending'),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wide
        title="Changes that wait for you"
        description="These changes at the source were large, so they were not made. Apply them if they are right, or keep what Sellora has. A kept change comes back only if the source changes again."
      >
        {items.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="Nothing waits for you" />
        ) : (
          <ul className="divide-y rounded-lg border">
            {items.map((h) => (
              <HeldEntry
                key={h.ref}
                orgId={orgId}
                currency={currency}
                change={h}
                manage={manage}
                busy={busy !== null}
                onDecide={(d) => void decide(h, d)}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PageText({
  orgId,
  sourceId,
  pageId,
}: {
  orgId: string;
  sourceId: string;
  pageId: string;
}) {
  const page = useQuery({
    queryKey: syncKeys.page(orgId, sourceId, pageId),
    queryFn: () => api<WebsitePage>(`/orgs/${orgId}/catalog-sources/${sourceId}/pages/${pageId}`),
  });
  if (page.isPending) return <Skeleton className="h-24" />;
  if (page.isError) return <Alert tone="danger">{errorMessage(page.error)}</Alert>;
  return (
    <div className="grid gap-1">
      {page.data.description && (
        <p className="text-[13px] text-muted-foreground">{page.data.description}</p>
      )}
      <p className="max-h-64 overflow-auto rounded-md bg-muted/50 p-3 text-[13px] whitespace-pre-wrap">
        {page.data.text || 'No text was found on this page.'}
      </p>
    </div>
  );
}

/** Asks the page store what the AI's search_website tool asks, and shows what it gets. */
function TryQuestion({ orgId }: { orgId: string }) {
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState('');
  const search = useQuery({
    queryKey: ['org', orgId, 'catalog-sync', 'website-search', asked],
    queryFn: () =>
      api<{ hits: WebsiteSearchHit[] }>(`/orgs/${orgId}/catalog-sources/website/search`, {
        query: { q: asked },
      }),
    enabled: asked.length > 0,
  });
  return (
    <section className="grid gap-2 rounded-lg border p-3" aria-labelledby="try-question">
      <h3 id="try-question" className="text-sm font-medium">
        Try a customer’s question
      </h3>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked(q.trim());
        }}
      >
        <Input
          aria-label="Question"
          placeholder="ডেলিভারি চার্জ কত? / Can I return a size?"
          value={q}
          maxLength={200}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!q.trim()}>
          <Search /> Search
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        The AI sales agent gets these lines when a customer asks something like it, and answers from
        them.
      </p>
      {asked &&
        (search.isPending ? (
          <Skeleton className="h-16" />
        ) : search.isError ? (
          <Alert tone="danger">{errorMessage(search.error)}</Alert>
        ) : search.data.hits.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No page matches “{asked}”. The AI says it does not know rather than guessing.
          </p>
        ) : (
          <ol className="grid gap-2" data-testid="search-hits">
            {search.data.hits.map((h) => (
              <li key={h.url} className="rounded-md bg-muted/50 p-3">
                <p className="text-sm font-medium">{h.title || h.url}</p>
                <p className="text-xs break-all text-muted-foreground">{h.url}</p>
                <p className="mt-1 text-[13px] whitespace-pre-wrap">{h.passages}</p>
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}

/** The pages kept from a website, and a way to see what the AI finds in them. */
export function PagesDialog({
  orgId,
  source,
  open,
  onOpenChange,
}: {
  orgId: string;
  source: CatalogSource;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const pages = useInfiniteQuery({
    queryKey: syncKeys.pages(orgId, source.id),
    queryFn: ({ pageParam }) =>
      api<Page<WebsitePage>>(`/orgs/${orgId}/catalog-sources/${source.id}/pages`, {
        query: { limit: 25, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open,
  });
  const items = pages.data?.pages.flatMap((p) => p.items) ?? [];
  const count = source.website?.pageCount ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wide
        title={`Pages from ${source.website?.host ?? source.name}`}
        description={`${formatNumber(count)} page${count === 1 ? '' : 's'} kept for the AI to answer from. They are read again on every sync; pages that are gone are removed.`}
      >
        <div className="grid gap-4">
          {count > 0 && <TryQuestion orgId={orgId} />}
          {pages.isPending ? (
            <Skeleton className="h-32" />
          ) : pages.isError ? (
            <Alert tone="danger">{errorMessage(pages.error)}</Alert>
          ) : items.length === 0 ? (
            <EmptyState icon={FileText} title="No pages yet">
              {source.website?.readPages === false
                ? 'Reading pages is off in this source’s settings.'
                : 'Pages appear after the site is verified and read.'}
            </EmptyState>
          ) : (
            <ul className="divide-y rounded-lg border">
              {items.map((p) => {
                const isOpen = shown === p.id;
                return (
                  <li key={p.id} className="px-4 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-start gap-2 text-left"
                        aria-expanded={isOpen}
                        onClick={() => setShown(isOpen ? null : p.id)}
                      >
                        <ChevronDown
                          className={cn(
                            'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform',
                            !isOpen && '-rotate-90',
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {p.title || new URL(p.url).pathname}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {new URL(p.url).pathname}
                            {new URL(p.url).search} · {formatNumber(p.words)} words · changed{' '}
                            {formatRelative(p.changedAt)}
                          </span>
                        </span>
                      </button>
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
                        aria-label={`Open ${p.title || p.url} on the site`}
                      >
                        <ExternalLink className="size-4" aria-hidden />
                      </a>
                    </div>
                    {isOpen && (
                      <div className="mt-2 pl-6">
                        <PageText orgId={orgId} sourceId={source.id} pageId={p.id} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <LoadMore
            hasMore={Boolean(pages.hasNextPage)}
            loading={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
