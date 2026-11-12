'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { seoKeys } from '@/components/seo/hooks';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { ApplyField, BulkItemState, SeoBulkRun } from '@/lib/api/types';
import { formatCredits } from '@/lib/format';
import { APPLY_DEFAULT, APPLY_LABEL, productHref } from '@/lib/seo';

const ITEM: Record<BulkItemState, { label: string; tone: BadgeTone }> = {
  waiting: { label: 'Waiting', tone: 'neutral' },
  written: { label: 'Ready to review', tone: 'info' },
  applied: { label: 'Saved', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

/**
 * One bulk optimiser run (ADR 0032): suggestions appear as AI writes them; the business
 * picks which fields to save and saves product by product, or all at once.
 */
export default function BulkRunPage() {
  const { org, can } = useOrg();
  const { runId } = useParams<{ runId: string }>();
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: seoKeys.bulkRun(org.id, runId),
    queryFn: () => api<SeoBulkRun>(`/orgs/${org.id}/seo/bulk/${runId}`),
    refetchInterval: (q) =>
      q.state.data?.status === 'queued' || q.state.data?.status === 'running' ? 2500 : false,
  });
  const [fields, setFields] = useState<ApplyField[]>(APPLY_DEFAULT);
  const [saving, setSaving] = useState<string | 'all' | null>(null);
  const canSave = can('catalog.manage');

  if (run.isError) return <PageError error={run.error} onRetry={() => void run.refetch()} />;
  if (!run.data) return <Skeleton className="h-64" />;
  const r = run.data;
  const going = r.status === 'queued' || r.status === 'running';
  const written = r.items.filter((i) => i.status === 'written');

  const refresh = (next: SeoBulkRun) => {
    queryClient.setQueryData(seoKeys.bulkRun(org.id, runId), next);
    void queryClient.invalidateQueries({ queryKey: seoKeys.bulk(org.id) });
    void queryClient.invalidateQueries({ queryKey: seoKeys.audit(org.id) });
  };

  const save = async (productId: string) => {
    const next = await api<SeoBulkRun>(
      `/orgs/${org.id}/seo/bulk/${runId}/items/${productId}/apply`,
      { body: { fields } },
    );
    refresh(next);
  };

  const saveOne = async (productId: string) => {
    setSaving(productId);
    try {
      await save(productId);
      toast.success('Saved to the product.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const saveAll = async () => {
    setSaving('all');
    let done = 0;
    try {
      for (const i of written) {
        await save(i.productId);
        done += 1;
      }
      toast.success(`Saved ${done} ${done === 1 ? 'product' : 'products'}.`);
    } catch (err) {
      toast.error(`${done} saved. ${errorMessage(err)}`);
    } finally {
      setSaving(null);
    }
  };

  const cancel = async () => {
    try {
      refresh(
        await api<SeoBulkRun>(`/orgs/${org.id}/seo/bulk/${runId}/cancel`, { method: 'POST' }),
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/app/${org.id}/seo`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> SEO overview
        </Link>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {going
            ? `Writing ${r.counts.written + r.counts.applied + r.counts.failed} of ${r.counts.total}…`
            : `${r.counts.written + r.counts.applied} of ${r.counts.total} written`}{' '}
          · {formatCredits(r.credits)}
        </p>
      </div>

      {r.status === 'cancelled' && (
        <Alert tone="warning" title="This run stopped">
          Products still waiting were not written. Suggestions already written can be saved.
        </Alert>
      )}
      {r.items.some((i) => i.status === 'failed') && (
        <Alert tone="danger" title="Some products could not be written">
          {[...new Set(r.items.filter((i) => i.error).map((i) => i.error))].join(' ')}
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What to save</CardTitle>
          <CardDescription>
            Choose the fields saved from each suggestion. The description, tags and address are off
            unless you turn them on, because they change what shoppers see.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {(Object.keys(APPLY_LABEL) as ApplyField[]).map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={fields.includes(f)}
                  onCheckedChange={(v) =>
                    setFields((list) => (v ? [...list, f] : list.filter((x) => x !== f)))
                  }
                />
                {APPLY_LABEL[f]}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {canSave && (
              <Button
                onClick={() => void saveAll()}
                disabled={!written.length || !fields.length || saving !== null}
                loading={saving === 'all'}
              >
                Save all ready ({written.length})
              </Button>
            )}
            {going && can('marketing.manage') && (
              <Button variant="outline" onClick={() => void cancel()}>
                Stop writing
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <ul className="grid gap-3">
        {r.items.map((i) => (
          <li key={i.productId}>
            <Card>
              <CardContent className="grid gap-3 pt-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={productHref(org.id, i.productId)}
                    className="font-medium hover:underline"
                  >
                    {i.name}
                  </Link>
                  <div className="flex items-center gap-2">
                    <span className="tabular text-sm text-muted-foreground">
                      {i.scoreBefore}
                      {i.scoreAfter !== null && (
                        <>
                          {' '}
                          <ArrowRight className="inline size-3.5" aria-label="becomes" />{' '}
                          <span className="font-semibold text-foreground">{i.scoreAfter}</span>
                        </>
                      )}
                    </span>
                    <Badge tone={ITEM[i.status].tone}>{ITEM[i.status].label}</Badge>
                  </div>
                </div>
                {i.suggestion && (
                  <dl className="grid gap-1.5 text-sm sm:grid-cols-[140px_1fr]">
                    <dt className="text-muted-foreground">Keywords</dt>
                    <dd>{i.suggestion.keywords.join(', ')}</dd>
                    <dt className="text-muted-foreground">Search title</dt>
                    <dd>{i.suggestion.seoTitle}</dd>
                    <dt className="text-muted-foreground">Meta description</dt>
                    <dd>{i.suggestion.metaDescription}</dd>
                    <dt className="text-muted-foreground">Questions</dt>
                    <dd>{i.suggestion.faq.map((f) => f.question).join(' · ') || '–'}</dd>
                    {fields.includes('slug') && (
                      <>
                        <dt className="text-muted-foreground">Address</dt>
                        <dd>/products/{i.suggestion.slug}</dd>
                      </>
                    )}
                  </dl>
                )}
                {i.status === 'written' && canSave && (
                  <div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void saveOne(i.productId)}
                      disabled={!fields.length || saving !== null}
                      loading={saving === i.productId}
                    >
                      Save to product
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
