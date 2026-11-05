'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileSpreadsheet,
  History,
  RefreshCw,
  Settings2,
  ShoppingBag,
  Store,
  Trash2,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { commerceKeys } from '@/components/commerce/hooks';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { CatalogSource, Page, SyncRun } from '@/lib/api/types';
import { formatDateTime, formatRelative } from '@/lib/format';
import { ToggleRow } from './add-source';
import {
  countsText,
  INTERVALS,
  intervalLabel,
  isFinished,
  readCsvFile,
  RUN_STATUS,
  syncKeys,
  TRIGGER_LABEL,
} from './shared';

const ICON = {
  shopify: ShoppingBag,
  woocommerce: Store,
  sheet: FileSpreadsheet,
  csv: Upload,
} as const;

function SourceStatus({ s, watching }: { s: CatalogSource; watching: boolean }) {
  if (s.running || watching)
    return (
      <Badge tone="info">
        <RefreshCw className="animate-spin" aria-hidden /> Syncing
      </Badge>
    );
  if (s.status === 'paused') return <Badge>Paused</Badge>;
  if (s.lastRun?.status === 'failed')
    return <Badge tone="danger">{s.failures > 1 ? `Failed ${s.failures} times` : 'Failed'}</Badge>;
  if (s.lastRun?.status === 'partial') return <Badge tone="warning">Done with problems</Badge>;
  if (!s.lastRun) return <Badge>Waiting</Badge>;
  return <Badge tone="success">Up to date</Badge>;
}

/** Follows one run until it ends, then refreshes sources and products and says how it went. */
function useRunWatcher(
  orgId: string,
  sourceId: string,
  runId: string | null,
  onDone: (run: SyncRun) => void,
) {
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: syncKeys.run(orgId, sourceId, runId ?? 'none'),
    queryFn: () => api<SyncRun>(`/orgs/${orgId}/catalog-sources/${sourceId}/runs/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: (q) => (q.state.data && isFinished(q.state.data.status) ? false : 1_500),
  });
  const done = useRef<string | null>(null);
  useEffect(() => {
    const r = run.data;
    if (!r || !isFinished(r.status) || done.current === r.id) return;
    done.current = r.id;
    void queryClient.invalidateQueries({ queryKey: syncKeys.sources(orgId) });
    void queryClient.invalidateQueries({ queryKey: syncKeys.runs(orgId, sourceId) });
    void queryClient.invalidateQueries({ queryKey: commerceKeys.all(orgId) });
    onDone(r);
  }, [run.data, orgId, sourceId, queryClient, onDone]);
  return run.data ?? null;
}

function RunProblems({ run }: { run: SyncRun }) {
  if (!run.problems.length) return null;
  return (
    <details className="mt-1 text-[13px]">
      <summary className="cursor-pointer text-muted-foreground">
        {run.problems.length + run.moreProblems} problem
        {run.problems.length + run.moreProblems === 1 ? '' : 's'}
      </summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {run.problems.map((p, i) => (
          <li key={i}>
            <span className="font-medium">{p.ref}:</span> {p.message}
          </li>
        ))}
        {run.moreProblems > 0 && <li>…and {run.moreProblems} more.</li>}
      </ul>
    </details>
  );
}

function HistoryDialog({
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
  const runs = useInfiniteQuery({
    queryKey: syncKeys.runs(orgId, source.id),
    queryFn: ({ pageParam }) =>
      api<Page<SyncRun>>(`/orgs/${orgId}/catalog-sources/${source.id}/runs`, {
        query: { limit: 20, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open,
  });
  const items = runs.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wide
        title={`Sync history: ${source.name}`}
        description="The last 90 days. Each sync lists the products it could not import and why."
      >
        {runs.isPending ? (
          <Skeleton className="h-32" />
        ) : runs.isError ? (
          <Alert tone="danger">{errorMessage(runs.error)}</Alert>
        ) : items.length === 0 ? (
          <EmptyState icon={History} title="No syncs yet" />
        ) : (
          <ul className="divide-y rounded-lg border">
            {items.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {TRIGGER_LABEL[r.trigger]}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {formatDateTime(r.finishedAt ?? r.createdAt)}
                    </span>
                  </span>
                  <Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge>
                </div>
                {isFinished(r.status) && r.status !== 'failed' && (
                  <p className="text-[13px] text-muted-foreground">{countsText(r.counts)}</p>
                )}
                {r.error && <p className="text-[13px] text-destructive">{r.error}</p>}
                <RunProblems run={r} />
              </li>
            ))}
          </ul>
        )}
        <LoadMore
          hasMore={Boolean(runs.hasNextPage)}
          loading={runs.isFetchingNextPage}
          onClick={() => void runs.fetchNextPage()}
        />
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialog({
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
  const queryClient = useQueryClient();
  const [name, setName] = useState(source.name);
  const [interval, setIntervalMinutes] = useState(source.intervalMinutes);
  const [newStatus, setNewStatus] = useState(source.newProductStatus);
  const [syncStock, setSyncStock] = useState(source.syncStock);
  const [archiveMissing, setArchiveMissing] = useState(source.archiveMissing);
  const [paused, setPaused] = useState(source.status === 'paused');
  const [url, setUrl] = useState(source.url ?? '');
  const [token, setToken] = useState('');
  const [ck, setCk] = useState('');
  const [cs, setCs] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const body: Record<string, unknown> = {};
    if (name.trim() && name.trim() !== source.name) body.name = name.trim();
    if (interval !== source.intervalMinutes) body.intervalMinutes = interval;
    if (newStatus !== source.newProductStatus) body.newProductStatus = newStatus;
    if (syncStock !== source.syncStock) body.syncStock = syncStock;
    if (archiveMissing !== source.archiveMissing) body.archiveMissing = archiveMissing;
    if (paused !== (source.status === 'paused')) body.status = paused ? 'paused' : 'active';
    if (source.kind !== 'csv' && url.trim() && url.trim() !== source.url) body.url = url.trim();
    if (source.kind === 'shopify' && token.trim()) body.credentials = { accessToken: token.trim() };
    if (source.kind === 'woocommerce' && (ck.trim() || cs.trim()))
      body.credentials = { consumerKey: ck.trim(), consumerSecret: cs.trim() };
    if (!Object.keys(body).length) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      await api<CatalogSource>(`/orgs/${orgId}/catalog-sources/${source.id}`, {
        method: 'PATCH',
        body,
      });
      await queryClient.invalidateQueries({ queryKey: syncKeys.sources(orgId) });
      toast.success('Saved.');
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Settings: ${source.name}`}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Name in Sellora" htmlFor="set-name" error={errors.name}>
            <Input
              id="set-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {source.kind !== 'csv' && (
            <Field label="Sync" htmlFor="set-interval" error={errors.intervalMinutes}>
              <NativeSelect
                id="set-interval"
                value={interval}
                onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              >
                {INTERVALS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="New products are" htmlFor="set-status">
            <NativeSelect
              id="set-status"
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value as 'active' | 'draft')}
            >
              <option value="active">Active</option>
              <option value="draft">Draft</option>
            </NativeSelect>
          </Field>
          <ToggleRow
            id="set-stock"
            label="Take stock counts from the source"
            checked={syncStock}
            onChange={setSyncStock}
          />
          <ToggleRow
            id="set-archive"
            label="Archive products that are removed at the source"
            checked={archiveMissing}
            onChange={setArchiveMissing}
          />
          {source.kind !== 'csv' && (
            <ToggleRow
              id="set-paused"
              label="Pause syncing"
              hint="Products stay as they are. Sync now still works."
              checked={paused}
              onChange={setPaused}
            />
          )}
          {source.kind !== 'csv' && (
            <details className="rounded-lg border px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium">Change address or key</summary>
              <div className="mt-3 grid gap-3">
                <Field label="Address" htmlFor="set-url" error={errors.url}>
                  <Input id="set-url" value={url} onChange={(e) => setUrl(e.target.value)} />
                </Field>
                {source.kind === 'shopify' && (
                  <Field
                    label="New access token"
                    htmlFor="set-token"
                    error={errors['credentials.accessToken']}
                    hint={`Now: ${source.credentialsHint ?? 'none'}. Leave empty to keep it.`}
                  >
                    <Input
                      id="set-token"
                      type="password"
                      autoComplete="off"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                  </Field>
                )}
                {source.kind === 'woocommerce' && (
                  <>
                    <Field
                      label="New consumer key"
                      htmlFor="set-ck"
                      error={errors['credentials.consumerKey']}
                      hint={`Now: ${source.credentialsHint ?? 'none'}. Leave both empty to keep them.`}
                    >
                      <Input
                        id="set-ck"
                        autoComplete="off"
                        value={ck}
                        onChange={(e) => setCk(e.target.value)}
                      />
                    </Field>
                    <Field
                      label="New consumer secret"
                      htmlFor="set-cs"
                      error={errors['credentials.consumerSecret']}
                    >
                      <Input
                        id="set-cs"
                        type="password"
                        autoComplete="off"
                        value={cs}
                        onChange={(e) => setCs(e.target.value)}
                      />
                    </Field>
                  </>
                )}
                <p className="text-[13px] text-muted-foreground">
                  A new address or key is checked before it is saved.
                </p>
              </div>
            </details>
          )}
          {formError && <Alert tone="danger">{formError}</Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SourceCard({
  orgId,
  source: s,
  manage,
  watchRunId,
  onWatch,
}: {
  orgId: string;
  source: CatalogSource;
  manage: boolean;
  watchRunId: string | null;
  onWatch: (runId: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'settings' | 'history' | 'remove' | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const Icon = ICON[s.kind];

  const run = useRunWatcher(orgId, s.id, watchRunId, (r) => {
    onWatch(null);
    if (r.status === 'failed') toast.error(`${s.name}: ${r.error ?? 'the sync failed.'}`);
    else if (r.status === 'partial')
      toast.warning(`${s.name}: ${countsText(r.counts)}. Some products were skipped.`);
    else toast.success(`${s.name}: ${countsText(r.counts)}.`);
  });
  const watching = Boolean(watchRunId && (!run || !isFinished(run.status)));

  const syncNow = async () => {
    setBusy(true);
    try {
      const r = await api<SyncRun>(`/orgs/${orgId}/catalog-sources/${s.id}/sync`, {
        method: 'POST',
      });
      onWatch(r.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    const read = await readCsvFile(file);
    if (!read.ok) {
      toast.error(read.message);
      return;
    }
    setBusy(true);
    try {
      const r = await api<SyncRun>(`/orgs/${orgId}/catalog-sources/${s.id}/upload`, {
        body: { filename: file.name, csv: read.text },
      });
      onWatch(r.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async () => {
    const res = await api<{ products: number }>(`/orgs/${orgId}/catalog-sources/${s.id}`, {
      method: 'DELETE',
    });
    await queryClient.invalidateQueries({ queryKey: syncKeys.sources(orgId) });
    void queryClient.invalidateQueries({ queryKey: commerceKeys.all(orgId) });
    toast.success(
      `${s.name} removed. Its ${res.products} product${res.products === 1 ? '' : 's'} stay as ordinary products.`,
    );
  };

  return (
    <Card data-testid={`source-${s.id}`} className="min-w-0">
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="shrink-0 rounded-lg bg-muted p-2">
              <Icon className="size-5 text-primary" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {s.name} <SourceStatus s={s} watching={watching} />
              </p>
              <p className="truncate text-[13px] text-muted-foreground">
                {s.kindLabel}
                {s.url ? ` · ${s.url}` : ''}
                {s.credentialsHint ? ` · key ${s.credentialsHint}` : ''}
              </p>
            </div>
          </div>
          {manage && (
            <div className="flex flex-wrap gap-1.5">
              {s.kind === 'csv' ? (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="sr-only"
                    aria-label={`New version of ${s.name}`}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(f);
                    }}
                  />
                  <Button
                    size="sm"
                    disabled={busy || watching}
                    onClick={() => fileRef.current?.click()}
                  >
                    <Upload /> Upload new version
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={busy || watching || s.running}
                  onClick={() => void syncNow()}
                >
                  <RefreshCw className={watching ? 'animate-spin' : undefined} /> Sync now
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setDialog('history')}>
                <History /> History
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Settings for ${s.name}`}
                onClick={() => setDialog('settings')}
              >
                <Settings2 />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${s.name}`}
                onClick={() => setDialog('remove')}
              >
                <Trash2 />
              </Button>
            </div>
          )}
          {!manage && (
            <Button size="sm" variant="outline" onClick={() => setDialog('history')}>
              <History /> History
            </Button>
          )}
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-[13px] text-muted-foreground">Products</dt>
            <dd>
              <Link
                href={`/app/${orgId}/products`}
                className="tabular font-medium underline-offset-2 hover:underline"
              >
                {s.productCount}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-[13px] text-muted-foreground">Last sync</dt>
            <dd>
              {s.lastRun ? (
                <span title={formatDateTime(s.lastRun.finishedAt)}>
                  {formatRelative(s.lastRun.finishedAt)}
                </span>
              ) : (
                'Not yet'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[13px] text-muted-foreground">Next sync</dt>
            <dd>
              {s.kind === 'csv'
                ? 'When you upload a new version'
                : s.status === 'paused'
                  ? 'Paused'
                  : s.nextSyncAt
                    ? `${formatRelative(s.nextSyncAt)} (${intervalLabel(s.intervalMinutes).toLowerCase()})`
                    : 'Only when you press Sync now'}
            </dd>
          </div>
        </dl>
        {s.lastRun && !watching && (
          <p className="text-[13px] text-muted-foreground">
            {s.lastRun.status === 'failed' ? (
              <span className="text-destructive">{s.lastRun.error}</span>
            ) : (
              <>Last sync: {countsText(s.lastRun.counts)}.</>
            )}
            {s.failures > 1 && s.status === 'active' && s.nextSyncAt && (
              <> Trying again {formatRelative(s.nextSyncAt)}.</>
            )}
          </p>
        )}
        {watching && (
          <p className="text-[13px] text-muted-foreground" aria-live="polite">
            {run?.status === 'running' ? 'Reading products…' : 'Waiting to start…'}
          </p>
        )}
      </CardContent>
      <HistoryDialog
        orgId={orgId}
        source={s}
        open={dialog === 'history'}
        onOpenChange={(o) => setDialog(o ? 'history' : null)}
      />
      {manage && (
        <>
          {dialog === 'settings' && (
            <SettingsDialog
              orgId={orgId}
              source={s}
              open
              onOpenChange={(o) => setDialog(o ? 'settings' : null)}
            />
          )}
          <ConfirmDialog
            open={dialog === 'remove'}
            onOpenChange={(o) => setDialog(o ? 'remove' : null)}
            title={`Remove ${s.name}?`}
            description={`Its ${s.productCount} product${s.productCount === 1 ? '' : 's'} stay in Sellora as ordinary products and stop updating. The saved key is deleted.`}
            confirmLabel="Remove source"
            destructive
            onConfirm={remove}
          />
        </>
      )}
    </Card>
  );
}
