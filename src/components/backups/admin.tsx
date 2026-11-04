'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, Download, FlaskConical, History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Switch } from '@/components/ui/switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  BackupDownloadLink,
  BackupRun,
  BackupSettings,
  RestorePart,
  RestorePreview,
  TenantBackups,
} from '@/lib/api/types';
import {
  RESTORE_STATUS,
  RUN_REASON,
  RUN_STATUS,
  anyInProgress,
  durationLabel,
  hourLabel,
  keptBytes,
  lastVerified,
  nextNightly,
  partsLabel,
} from '@/lib/backups';
import { formatDateTime, formatNumber, formatRelative, formatStorage } from '@/lib/format';

export const backupKeys = {
  all: ['platform', 'backups'] as const,
  settings: () => [...backupKeys.all, 'settings'] as const,
  runs: () => [...backupKeys.all, 'runs'] as const,
  tenant: (orgId: string) => [...backupKeys.all, 'tenant', orgId] as const,
};

export function useBackupSettings() {
  return useQuery({
    queryKey: backupKeys.settings(),
    queryFn: () => api<BackupSettings>('/platform/backups/settings'),
  });
}

export function useBackupRuns() {
  return useQuery({
    queryKey: backupKeys.runs(),
    queryFn: () =>
      api<BackupRun[]>('/platform/backups/runs', { query: { scope: 'platform', limit: 60 } }),
    // While a backup is being made or checked, look again every few seconds.
    refetchInterval: (q) => (anyInProgress(q.state.data ?? []) ? 3000 : 60_000),
  });
}

// ---------------------------------------------------------------- summary

export function BackupSummary({ settings, runs }: { settings: BackupSettings; runs: BackupRun[] }) {
  const last = lastVerified(runs);
  const tested = runs
    .filter((r) => r.testRestore)
    .sort((a, b) => b.testRestore!.at.localeCompare(a.testRestore!.at))[0];
  const kept = runs.filter((r) => r.status === 'verified');
  // Fixed per render: the next slot moves only when the settings change.
  const [now] = useState(() => new Date());
  const next = settings.enabled ? nextNightly(now, settings) : null;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="backup-summary">
      <Stat
        label="Last verified backup"
        value={last ? formatRelative(last.startedAt) : 'None yet'}
        sub={last ? formatDateTime(last.startedAt) : 'Back up now to make the first one.'}
      />
      <Stat
        label="Next nightly backup"
        value={next ? formatDateTime(next.toISOString(), settings.timezone) : 'Off'}
        sub={
          next
            ? `${hourLabel(settings.hour)} ${settings.timezone}`
            : 'Nightly backups are turned off.'
        }
      />
      <Stat
        label="Backups kept"
        value={formatNumber(kept.length)}
        sub={`${formatStorage(keptBytes(kept))} in storage`}
      />
      <Stat
        label="Last test restore"
        value={tested ? (tested.testRestore!.ok ? 'Passed' : 'Failed') : 'Not yet'}
        sub={
          tested
            ? `${formatDateTime(tested.testRestore!.at)}, ${durationLabel(tested.testRestore!.ms)}`
            : 'The weekly copy is test-restored by itself.'
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------- settings

export function BackupSettingsCard({ settings }: { settings: BackupSettings }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [hour, setHour] = useState(settings.hour);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [keep, setKeep] = useState(settings.keep);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      api<BackupSettings>('/platform/backups/settings', {
        method: 'PATCH',
        body: { enabled, hour, timezone: timezone.trim(), keep },
      }),
    onSuccess: (s) => {
      setErrors({});
      qc.setQueryData(backupKeys.settings(), s);
      toast.success('Backup settings saved.');
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      toast.error(errorMessage(err));
    },
  });
  const number = (v: string, min: number, max: number) =>
    Math.min(max, Math.max(min, Number.parseInt(v || '0', 10) || 0));

  return (
    <Card data-testid="backup-settings">
      <CardHeader>
        <CardTitle>Nightly backups</CardTitle>
        <CardDescription>
          Every night Sellora backs up the whole database, reads the file back to check it, and
          keeps the newest copies. A week&apos;s first backup is also test-restored into a temporary
          database.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Back up every night"
            />
            Back up every night
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Time" htmlFor="backup-hour">
              <NativeSelect
                id="backup-hour"
                value={hour}
                onChange={(e) => setHour(Number(e.target.value))}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              label="Time zone"
              htmlFor="backup-timezone"
              error={errors.timezone}
              hint="For example Asia/Dhaka."
            >
              <Input
                id="backup-timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                aria-invalid={Boolean(errors.timezone)}
              />
            </Field>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Keep</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Newest daily copies" htmlFor="keep-daily">
                <Input
                  id="keep-daily"
                  inputMode="numeric"
                  value={keep.daily}
                  onChange={(e) => setKeep({ ...keep, daily: number(e.target.value, 1, 60) })}
                />
              </Field>
              <Field label="Weekly copies" htmlFor="keep-weekly">
                <Input
                  id="keep-weekly"
                  inputMode="numeric"
                  value={keep.weekly}
                  onChange={(e) => setKeep({ ...keep, weekly: number(e.target.value, 0, 52) })}
                />
              </Field>
              <Field label="Monthly copies" htmlFor="keep-monthly">
                <Input
                  id="keep-monthly"
                  inputMode="numeric"
                  value={keep.monthly}
                  onChange={(e) => setKeep({ ...keep, monthly: number(e.target.value, 0, 36) })}
                />
              </Field>
            </div>
            <p className="text-[13px] text-muted-foreground">
              A backup can be the daily, weekly and monthly copy at once; it is kept while any of
              them needs it.
            </p>
          </fieldset>
          <div className="grid gap-2 text-sm text-muted-foreground">
            <p>
              Files are encrypted (AES-256-GCM) with backup key{' '}
              <span className="font-mono text-foreground">{settings.keyId}</span>. Keep a copy of
              that key somewhere safe outside the server: without it no backup can be read.
            </p>
            <p>
              Off-site copy:{' '}
              {settings.offsiteConfigured ? (
                <Badge tone="success">Set up</Badge>
              ) : (
                <>
                  <Badge tone="warning">Not set up</Badge> Set the BACKUP_OFFSITE_S3_ settings on
                  the server to copy each backup to a second bucket.
                </>
              )}
            </p>
          </div>
          <div>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- the list

function RunStatus({ run }: { run: BackupRun }) {
  const s = RUN_STATUS[run.status];
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone={s.tone}>{s.label}</Badge>
        {run.tiers.map((t) => (
          <Badge key={t} tone="outline">
            {t}
          </Badge>
        ))}
      </div>
      {run.error && <p className="max-w-80 text-[13px] text-destructive">{run.error}</p>}
    </div>
  );
}

function RunChecks({ run }: { run: BackupRun }) {
  return (
    <div className="grid gap-0.5 text-[13px]">
      <span>
        Test restore:{' '}
        {run.testRestorePending ? (
          <span className="text-primary">waiting…</span>
        ) : run.testRestore ? (
          run.testRestore.ok ? (
            <span className="text-success">passed in {durationLabel(run.testRestore.ms)}</span>
          ) : (
            <span className="text-destructive" title={run.testRestore.error ?? undefined}>
              failed
            </span>
          )
        ) : (
          <span className="text-muted-foreground">not run</span>
        )}
      </span>
      {run.offsite && (
        <span>
          Off-site:{' '}
          {run.offsite.ok ? (
            <span className="text-success">copied</span>
          ) : (
            <span className="text-destructive" title={run.offsite.error ?? undefined}>
              failed
            </span>
          )}
        </span>
      )}
    </div>
  );
}

export function BackupRunsCard({ runs }: { runs: BackupRun[] }) {
  const qc = useQueryClient();
  const [downloading, setDownloading] = useState<BackupRun | null>(null);
  const backUp = useMutation({
    mutationFn: () => api<BackupRun>('/platform/backups/runs', { method: 'POST' }),
    onSuccess: async () => {
      toast.success('Backup started. It is checked as soon as it is made.');
      await qc.invalidateQueries({ queryKey: backupKeys.runs() });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const test = useMutation({
    mutationFn: (id: string) =>
      api<BackupRun>(`/platform/backups/runs/${id}/test-restore`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success('Test restore started.');
      await qc.invalidateQueries({ queryKey: backupKeys.runs() });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const going = runs.some((r) => r.status === 'running' || r.status === 'verifying');

  return (
    <Card data-testid="backup-runs">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>Platform backups</CardTitle>
          <CardDescription>
            The newest first. Removed backups stay listed for a year without their file.
          </CardDescription>
        </div>
        <Button onClick={() => backUp.mutate()} loading={backUp.isPending} disabled={going}>
          <DatabaseBackup aria-hidden />
          Back up now
        </Button>
      </CardHeader>
      <CardContent>
        {runs.length === 0 ? (
          <EmptyState icon={History} title="No backups yet">
            The first nightly backup runs at the time set below, or back up now.
          </EmptyState>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Started</TH>
                <TH>Status</TH>
                <TH className="text-right">Size</TH>
                <TH>Checks</TH>
                <TH className="text-right">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {runs.map((r) => (
                <TR key={r.id} data-testid={`backup-run-${r.id}`}>
                  <TD>
                    <div className="font-medium">{formatDateTime(r.startedAt)}</div>
                    <div className="text-[13px] text-muted-foreground">
                      {RUN_REASON[r.reason]}
                      {r.startedBy?.label ? ` by ${r.startedBy.label}` : ''}
                      {r.durationMs !== null ? `, ${durationLabel(r.durationMs)}` : ''}
                    </div>
                  </TD>
                  <TD>
                    <RunStatus run={r} />
                  </TD>
                  <TD className="tabular text-right">
                    {r.size !== null ? formatStorage(r.size) : '—'}
                    {r.docs !== null && (
                      <div className="text-[13px] text-muted-foreground">
                        {formatNumber(r.docs)} records
                      </div>
                    )}
                  </TD>
                  <TD>{r.status === 'verified' ? <RunChecks run={r} /> : null}</TD>
                  <TD className="text-right">
                    {r.status === 'verified' && (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => test.mutate(r.id)}
                          disabled={r.testRestorePending || test.isPending}
                        >
                          <FlaskConical aria-hidden />
                          Test restore
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setDownloading(r)}>
                          <Download aria-hidden />
                          Download
                        </Button>
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
      {downloading && <DownloadDialog run={downloading} onClose={() => setDownloading(null)} />}
    </Card>
  );
}

/** A 2-step code field: six digits, as the authenticator app shows them. */
function CodeField({
  id,
  value,
  onChange,
  error,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <Field
      label="2-step code"
      htmlFor={id}
      error={error}
      hint="From your authenticator app. Each code works once."
    >
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        aria-invalid={Boolean(error)}
        className="w-36 font-mono tracking-widest"
      />
    </Field>
  );
}

function DownloadDialog({ run, onClose }: { run: BackupRun; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const link = useMutation({
    mutationFn: () =>
      api<BackupDownloadLink>(`/platform/backups/runs/${run.id}/download`, {
        method: 'POST',
        body: { code, reason: reason.trim() },
      }),
    onSuccess: (l) => {
      const a = document.createElement('a');
      a.href = l.url;
      a.download = l.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success('The download has started. The file is still encrypted.');
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      toast.error(errorMessage(err));
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Download this backup?"
        description={`The ${formatStorage(run.size ?? 0)} file from ${formatDateTime(run.startedAt)}, still encrypted. Read it with "npm run backup" and the backup key. The download is recorded in the audit log.`}
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            link.mutate();
          }}
        >
          <Field label="Why do you need it?" htmlFor="download-reason" error={errors.reason}>
            <Textarea
              id="download-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <CodeField id="download-code" value={code} onChange={setCode} error={errors.code} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={link.isPending}
              disabled={reason.trim().length < 5 || code.length !== 6}
            >
              Download
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- one business

function pointLabel(r: BackupRun): string {
  const kind = r.scope === 'platform' ? 'Platform backup' : RUN_REASON[r.reason];
  return `${formatDateTime(r.startedAt)} · ${kind}`;
}

/** Admin › Businesses › one business: its backups, what a restore would change, restoring. */
export function TenantBackupsCard({ orgId, name }: { orgId: string; name: string }) {
  const qc = useQueryClient();
  const settings = useBackupSettings();
  const data = useQuery({
    queryKey: backupKeys.tenant(orgId),
    queryFn: () => api<TenantBackups>(`/platform/backups/tenants/${orgId}`),
    refetchInterval: (q) =>
      q.state.data && anyInProgress([], q.state.data.restores) ? 3000 : false,
  });
  const [runId, setRunId] = useState('');
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [parts, setParts] = useState<RestorePart[]>([]);
  const [restoring, setRestoring] = useState(false);

  const backUp = useMutation({
    mutationFn: () => api<BackupRun>(`/platform/backups/tenants/${orgId}/runs`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success('Backing up this business. It appears below when it is checked.');
      setTimeout(() => void qc.invalidateQueries({ queryKey: backupKeys.tenant(orgId) }), 4000);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const look = useMutation({
    mutationFn: (id: string) =>
      api<RestorePreview>(`/platform/backups/tenants/${orgId}/preview`, {
        method: 'POST',
        body: { runId: id },
      }),
    onSuccess: (p) => {
      setPreview(p);
      setParts([]);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (data.isPending || settings.isPending) return <Skeleton className="h-48 w-full" />;
  if (data.isError) return <ErrorState error={data.error} onRetry={() => void data.refetch()} />;
  if (settings.isError)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const { points, restores } = data.data;
  const chosen = runId || points[0]?.id || '';
  const going = restores.some((r) => r.status === 'running');

  return (
    <Card className="lg:col-span-2" data-testid="tenant-backups">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>Backups and restore</CardTitle>
          <CardDescription>
            Put back chosen parts of this business from a backup. A safety backup of the business is
            made first, so a restore can be undone.
          </CardDescription>
        </div>
        <Button variant="outline" onClick={() => backUp.mutate()} loading={backUp.isPending}>
          <DatabaseBackup aria-hidden />
          Back up this business now
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5">
        {points.length === 0 ? (
          <EmptyState icon={History} title="No backup holds this business yet">
            The next nightly backup will, or back it up now.
          </EmptyState>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Backup" htmlFor="restore-point" className="min-w-72 flex-1">
              <NativeSelect
                id="restore-point"
                value={chosen}
                onChange={(e) => {
                  setRunId(e.target.value);
                  setPreview(null);
                }}
              >
                {points.map((r) => (
                  <option key={r.id} value={r.id}>
                    {pointLabel(r)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button
              variant="outline"
              onClick={() => look.mutate(chosen)}
              loading={look.isPending}
              disabled={!chosen}
            >
              See what would change
            </Button>
          </div>
        )}

        {preview && preview.run.id === chosen && (
          <div className="grid gap-3" data-testid="restore-preview">
            <Table>
              <THead>
                <TR>
                  <TH className="w-10">
                    <span className="sr-only">Restore</span>
                  </TH>
                  <TH>Part</TH>
                  <TH className="text-right">In the backup</TH>
                  <TH className="text-right">Now</TH>
                  <TH className="text-right">Comes back</TH>
                  <TH className="text-right">Replaced</TH>
                  <TH className="text-right">Removed</TH>
                </TR>
              </THead>
              <TBody>
                {preview.parts.map((p) => (
                  <TR key={p.part}>
                    <TD>
                      <Checkbox
                        id={`part-${p.part}`}
                        checked={parts.includes(p.part)}
                        onCheckedChange={(c) =>
                          setParts(c ? [...parts, p.part] : parts.filter((x) => x !== p.part))
                        }
                        aria-label={`Restore ${p.label}`}
                      />
                    </TD>
                    <TD>
                      <label htmlFor={`part-${p.part}`} className="font-medium">
                        {p.label}
                      </label>
                    </TD>
                    <TD className="tabular text-right">{formatNumber(p.inBackup)}</TD>
                    <TD className="tabular text-right">{formatNumber(p.now)}</TD>
                    <TD className="tabular text-right">{formatNumber(p.added)}</TD>
                    <TD className="tabular text-right">{formatNumber(p.replaced)}</TD>
                    <TD
                      className={`tabular text-right ${p.removed ? 'font-medium text-destructive' : ''}`}
                    >
                      {formatNumber(p.removed)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <p className="text-[13px] text-muted-foreground">
              &ldquo;Removed&rdquo; are records made since the backup: a restore takes them out.
              Money (wallet, payments, invoices), the audit log, staff access, SMS opt-outs,
              connected accounts and message logs are never restored for one business.
            </p>
            <div>
              <Button
                variant="destructive"
                disabled={parts.length === 0 || going}
                onClick={() => setRestoring(true)}
              >
                <RotateCcw aria-hidden />
                Restore {parts.length ? partsLabel(parts, settings.data.parts) : 'selected parts'}…
              </Button>
            </div>
          </div>
        )}

        {restores.length > 0 && (
          <div className="grid gap-2">
            <h4 className="text-sm font-medium">Restores</h4>
            <Table data-testid="tenant-restores">
              <THead>
                <TR>
                  <TH>Started</TH>
                  <TH>Parts</TH>
                  <TH>Status</TH>
                  <TH>Reason</TH>
                </TR>
              </THead>
              <TBody>
                {restores.map((r) => {
                  const s = RESTORE_STATUS[r.status];
                  const written = Object.values(r.restored).reduce((n, x) => n + x, 0);
                  return (
                    <TR key={r.id}>
                      <TD>
                        <div>{formatDateTime(r.startedAt)}</div>
                        <div className="text-[13px] text-muted-foreground">{r.by.label}</div>
                      </TD>
                      <TD>{partsLabel(r.parts, settings.data.parts)}</TD>
                      <TD>
                        <Badge tone={s.tone}>{s.label}</Badge>
                        {r.status === 'done' && (
                          <div className="text-[13px] text-muted-foreground">
                            {formatNumber(written)} records put back
                          </div>
                        )}
                        {r.error && (
                          <p className="max-w-80 text-[13px] text-destructive">{r.error}</p>
                        )}
                        {r.safetyRunId && r.status !== 'running' && (
                          <Button
                            variant="link"
                            size="sm"
                            className="text-[13px]"
                            onClick={() => {
                              setRunId(r.safetyRunId!);
                              look.mutate(r.safetyRunId!);
                            }}
                          >
                            Undo: preview the safety backup
                          </Button>
                        )}
                      </TD>
                      <TD className="max-w-64 text-[13px]">{r.reason}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </CardContent>
      {restoring && preview && (
        <RestoreDialog
          orgId={orgId}
          name={name}
          preview={preview}
          parts={parts}
          catalogue={settings.data.parts}
          onClose={() => setRestoring(false)}
          onDone={async () => {
            setPreview(null);
            setParts([]);
            await qc.invalidateQueries({ queryKey: backupKeys.tenant(orgId) });
          }}
        />
      )}
    </Card>
  );
}

function RestoreDialog({
  orgId,
  name,
  preview,
  parts,
  catalogue,
  onClose,
  onDone,
}: {
  orgId: string;
  name: string;
  preview: RestorePreview;
  parts: RestorePart[];
  catalogue: BackupSettings['parts'];
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const removed = preview.parts
    .filter((p) => parts.includes(p.part))
    .reduce((n, p) => n + p.removed, 0);
  const restore = useMutation({
    mutationFn: () =>
      api(`/platform/backups/tenants/${orgId}/restores`, {
        method: 'POST',
        body: { runId: preview.run.id, parts, reason: reason.trim(), confirmName, code },
      }),
    onSuccess: async () => {
      toast.success('Restore started. The owner is emailed when it is done.');
      onClose();
      await onDone();
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      toast.error(errorMessage(err));
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Restore ${partsLabel(parts, catalogue)}?`}
        description={`${name}'s ${partsLabel(parts, catalogue).toLowerCase()} become as they were on ${formatDateTime(preview.run.startedAt)}.`}
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            restore.mutate();
          }}
        >
          {removed > 0 && (
            <Alert tone="warning">
              {formatNumber(removed)} records made since then will be taken out. They stay in the
              safety backup.
            </Alert>
          )}
          <Field label="Why?" htmlFor="restore-reason" error={errors.reason}>
            <Textarea
              id="restore-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Field
            label={`Type the business's name: ${name}`}
            htmlFor="restore-name"
            error={errors.confirmName}
          >
            <Input
              id="restore-name"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <CodeField id="restore-code" value={code} onChange={setCode} error={errors.code} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={restore.isPending}
              disabled={
                reason.trim().length < 5 || confirmName.trim() !== name.trim() || code.length !== 6
              }
            >
              Restore
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
