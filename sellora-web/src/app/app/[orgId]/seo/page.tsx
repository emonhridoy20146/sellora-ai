'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, ExternalLink, Package, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { seoKeys, useBulkRuns, useSeoAudit } from '@/components/seo/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { SeoBulkRun, SeoCheckKey, WriterLanguage } from '@/lib/api/types';
import { formatCredits, formatDateTime, formatNumber } from '@/lib/format';
import {
  BAND_LABEL,
  CHECK_LABEL,
  LANGUAGE_OPTIONS,
  STORE_CHECK_LABEL,
  productHref,
  scoreBand,
} from '@/lib/seo';

const BAND_TONE = { good: 'success', fair: 'warning', poor: 'danger' } as const;
const RUN_LABEL: Record<SeoBulkRun['status'], string> = {
  queued: 'Waiting to start',
  running: 'Writing',
  done: 'Done',
  cancelled: 'Stopped',
};
const SHOWN = 25;

/**
 * The SEO overview (ADR 0032): every active product's score with what to fix, the store's
 * own checks, and the bulk optimiser that writes AI suggestions for many products at once.
 */
export default function SeoOverviewPage() {
  const { org, can } = useOrg();
  const router = useRouter();
  const queryClient = useQueryClient();
  const audit = useSeoAudit(org.id);
  const runs = useBulkRuns(org.id);
  const editable = can('marketing.manage');
  const [language, setLanguage] = useState<WriterLanguage>('bn');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const [starting, setStarting] = useState(false);

  if (audit.isError) return <PageError error={audit.error} onRetry={() => void audit.refetch()} />;
  if (!audit.data)
    return (
      <div className="grid gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );

  const { products, stores } = audit.data;
  const going = runs.data?.items.find((r) => r.status === 'queued' || r.status === 'running');
  const shown = all ? products.items : products.items.slice(0, SHOWN);
  const below = products.items.filter((p) => p.score < 80).length;

  const start = async () => {
    setStarting(true);
    try {
      const run = await api<SeoBulkRun>(`/orgs/${org.id}/seo/bulk`, {
        body: picked.size ? { productIds: [...picked], language } : { below: 80, language },
      });
      void queryClient.invalidateQueries({ queryKey: seoKeys.bulk(org.id) });
      router.push(`/app/${org.id}/seo/bulk/${run.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const issues = (Object.entries(products.issues) as [SeoCheckKey, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Average product score"
          value={products.average ?? '–'}
          sub={`${formatNumber(products.count)} active products`}
        />
        <Stat label="Good (80 or more)" value={formatNumber(products.good)} />
        <Stat label="Needs work (50 to 79)" value={formatNumber(products.fair)} />
        <Stat label="Poor (under 50)" value={formatNumber(products.poor)} />
      </div>

      {stores.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Your store</CardTitle>
            <CardDescription>
              The sitemap lists every product for Google; it updates by itself.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {stores.map((s) => (
              <div key={s.id} className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {s.name} <span className="font-normal text-muted-foreground">{s.url}</span>
                  </p>
                  <div className="flex flex-wrap gap-3 text-[13px]">
                    <a
                      href={s.sitemapUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      Sitemap <ExternalLink className="size-3" aria-hidden />
                    </a>
                    <a
                      href={s.robotsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      robots.txt <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </div>
                </div>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {s.checks.map((c) => (
                    <li key={c.key} className="flex items-start gap-2 text-sm">
                      {c.ok ? (
                        <CircleCheck className="mt-0.5 size-4 text-success" aria-label="Done" />
                      ) : (
                        <CircleX className="mt-0.5 size-4 text-destructive" aria-label="To do" />
                      )}
                      <span>
                        {STORE_CHECK_LABEL[c.key]}{' '}
                        <span className="text-muted-foreground">({c.detail})</span>
                        {!c.ok && c.key === 'search_console' && (
                          <Link
                            href={`/app/${org.id}/seo/search-console`}
                            className="ml-1 text-primary hover:underline"
                          >
                            Connect
                          </Link>
                        )}
                        {!c.ok && (c.key === 'store_title' || c.key === 'store_description') && (
                          <Link
                            href={`/app/${org.id}/store/${s.id}/details`}
                            className="ml-1 text-primary hover:underline"
                          >
                            Edit
                          </Link>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {editable && products.count > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Fix with AI</CardTitle>
            <CardDescription>
              AI writes a search title, meta description, keywords, alt text and questions for up to
              50 products. You review each suggestion and choose what to save. Each product uses AI
              credit.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Language"
              value={language}
              onChange={setLanguage}
              options={LANGUAGE_OPTIONS}
            />
            <Button
              onClick={() => void start()}
              loading={starting}
              disabled={Boolean(going) || (!picked.size && !below)}
            >
              <Sparkles />
              {picked.size
                ? `Write for ${picked.size} chosen`
                : `Write for products under 80 (${Math.min(50, below)})`}
            </Button>
            {going && (
              <Link
                href={`/app/${org.id}/seo/bulk/${going.id}`}
                className="text-sm text-primary hover:underline"
              >
                A run is writing: {going.counts.written} of {going.counts.total}
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {issues.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Most common problems</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 sm:grid-cols-2">
              {issues.map(([k, n]) => (
                <li key={k} className="text-sm">
                  <span className="font-medium">{CHECK_LABEL[k].name}</span>: {formatNumber(n)}{' '}
                  {n === 1 ? 'product' : 'products'}
                  <span className="block text-[13px] text-muted-foreground">
                    {CHECK_LABEL[k].fix}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Products, lowest score first</CardTitle>
          {products.truncated && (
            <CardDescription>Only the first 2,000 active products are scored.</CardDescription>
          )}
        </CardHeader>
        {products.items.length === 0 ? (
          <EmptyState icon={Package} title="No active products yet">
            Add products and their search fields show here with a score.
          </EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    {editable && (
                      <TH className="w-10">
                        <span className="sr-only">Choose</span>
                      </TH>
                    )}
                    <TH>Product</TH>
                    <TH className="w-28">Score</TH>
                    <TH>To fix</TH>
                  </TR>
                </THead>
                <TBody>
                  {shown.map((p) => {
                    const band = scoreBand(p.score);
                    return (
                      <TR key={p.id}>
                        {editable && (
                          <TD>
                            <Checkbox
                              aria-label={`Choose ${p.name}`}
                              checked={picked.has(p.id)}
                              disabled={!picked.has(p.id) && picked.size >= 50}
                              onCheckedChange={(v) =>
                                setPicked((s) => {
                                  const n = new Set(s);
                                  if (v) n.add(p.id);
                                  else n.delete(p.id);
                                  return n;
                                })
                              }
                            />
                          </TD>
                        )}
                        <TD>
                          <Link
                            href={productHref(org.id, p.id)}
                            className="font-medium hover:underline"
                          >
                            {p.name}
                          </Link>
                          <span className="block text-[13px] text-muted-foreground">
                            /products/{p.slug}
                          </span>
                        </TD>
                        <TD>
                          <span className="tabular mr-2 font-semibold">{p.score}</span>
                          <Badge tone={BAND_TONE[band]}>{BAND_LABEL[band]}</Badge>
                        </TD>
                        <TD className="text-[13px] text-muted-foreground">
                          {p.failing.length
                            ? p.failing
                                .slice(0, 3)
                                .map((k) => CHECK_LABEL[k].name)
                                .join(', ') +
                              (p.failing.length > 3 ? ` and ${p.failing.length - 3} more` : '')
                            : 'Nothing'}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            {products.items.length > SHOWN && (
              <div className="border-t p-3 text-center">
                <Button variant="ghost" size="sm" onClick={() => setAll((a) => !a)}>
                  {all ? 'Show fewer' : `Show all ${formatNumber(products.items.length)}`}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {runs.data && runs.data.items.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>AI runs</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Started</TH>
                  <TH>Status</TH>
                  <TH>Written</TH>
                  <TH>Saved</TH>
                  <TH>Credits</TH>
                </TR>
              </THead>
              <TBody>
                {runs.data.items.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      <Link
                        href={`/app/${org.id}/seo/bulk/${r.id}`}
                        className="text-primary hover:underline"
                      >
                        {formatDateTime(r.createdAt, org.timezone)}
                      </Link>
                    </TD>
                    <TD>{RUN_LABEL[r.status]}</TD>
                    <TD className="tabular">
                      {r.counts.written + r.counts.applied} of {r.counts.total}
                    </TD>
                    <TD className="tabular">{r.counts.applied}</TD>
                    <TD className="tabular">{formatCredits(r.credits)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
