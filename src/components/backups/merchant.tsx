'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Download, FileArchive, History, RotateCcw, Unplug } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  BackupExport,
  DriveConnection,
  MerchantBackups,
  MerchantRestorePoint,
  RestorePart,
  RestorePreview,
} from '@/lib/api/types';
import { RESTORE_STATUS, partsLabel } from '@/lib/backups';
import { formatDateTime, formatNumber, formatRelative, formatStorage } from '@/lib/format';
import { RestorePreviewTable } from './admin';

export const merchantBackupKeys = {
  all: (orgId: string) => ['orgs', orgId, 'backups'] as const,
};

/** Settings › Backups: everything on the page, polled while something is being made. */
export function useMerchantBackups(orgId: string, enabled = true) {
  return useQuery({
    queryKey: merchantBackupKeys.all(orgId),
    enabled,
    queryFn: () => api<MerchantBackups>(`/orgs/${orgId}/backups`),
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      const busy =
        d.exports.some((e) => e.status === 'running') ||
        d.points.some((p) => p.status === 'making') ||
        d.restores.some((r) => r.status === 'running') ||
        Boolean(d.drive?.copying);
      return busy ? 3000 : 60_000;
    },
  });
}

const EXPORT_STATUS: Record<BackupExport['status'], { label: string; tone: BadgeTone }> = {
  running: { label: 'Preparing', tone: 'info' },
  ready: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  expired: { label: 'Removed after 7 days', tone: 'neutral' },
};

const POINT_KIND: Record<MerchantRestorePoint['kind'], string> = {
  restore_point: 'Your restore point',
  safety: 'Safety copy made before a restore',
  nightly: "Sellora's nightly backup",
  support: 'Made by Sellora support',
};

export function pointLabel(p: MerchantRestorePoint): string {
  return `${formatDateTime(p.startedAt)} · ${POINT_KIND[p.kind]}${p.by ? ` (${p.by})` : ''}`;
}

/** What Google's redirect back means, as the page says it. */
export const DRIVE_RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Google Drive is connected. The first copy is being saved now.' },
  denied: { ok: false, text: 'Google Drive was not connected: access was not allowed on Google.' },
  no_permission: {
    ok: false,
    text: 'Google Drive was not connected: tick the box that lets Sellora save its files, then try again.',
  },
  failed: { ok: false, text: 'Google Drive could not be connected. Try again in a minute.' },
  expired: { ok: false, text: 'That Google sign-in had expired. Connect Google Drive again.' },
};

// ---------------------------------------------------------------- download your data

export function ExportCard({ orgId, data }: { orgId: string; data: MerchantBackups }) {
  const qc = useQueryClient();
  const prepare = useMutation({
    mutationFn: () => api<BackupExport>(`/orgs/${orgId}/backups/exports`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success('Preparing your download. It takes a minute or two.');
      await qc.invalidateQueries({ queryKey: merchantBackupKeys.all(orgId) });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const download = useMutation({
    mutationFn: (id: string) =>
      api<{ url: string; expiresAt: string }>(`/orgs/${orgId}/backups/exports/${id}/link`, {
        method: 'POST',
      }),
    onSuccess: (link) => {
      window.location.assign(link.url);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const preparing = data.exports.some((e) => e.status === 'running');

  return (
    <Card data-testid="export-card">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>Download your data</CardTitle>
          <CardDescription>
            A ZIP with everything your business keeps in Sellora: products, customers and orders as
            spreadsheets (CSV), and all records as JSON files. It opens without Sellora. Passwords
            and connection keys are never in it.
          </CardDescription>
        </div>
        <Button onClick={() => prepare.mutate()} loading={prepare.isPending} disabled={preparing}>
          <FileArchive aria-hidden />
          {preparing ? 'Preparing…' : 'Prepare a download'}
        </Button>
      </CardHeader>
      <CardContent>
        {data.exports.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No downloads yet. A download is kept for 7 days.
          </p>
        ) : (
          <Table data-testid="exports">
            <THead>
              <TR>
                <TH>Asked for</TH>
                <TH>Status</TH>
                <TH className="text-right">Size</TH>
                <TH>
                  <span className="sr-only">Download</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {data.exports.map((e) => {
                const s = EXPORT_STATUS[e.status];
                return (
                  <TR key={e.id} data-testid={`export-${e.id}`}>
                    <TD>
                      <div>{formatDateTime(e.startedAt)}</div>
                      {e.requestedBy && (
                        <div className="text-[13px] text-muted-foreground">{e.requestedBy}</div>
                      )}
                    </TD>
                    <TD>
                      <Badge tone={s.tone}>{s.label}</Badge>
                      {e.status === 'ready' && e.expiresAt && (
                        <div className="text-[13px] text-muted-foreground">
                          Removed {formatRelative(e.expiresAt)}
                        </div>
                      )}
                      {e.error && (
                        <p className="max-w-80 text-[13px] text-destructive">{e.error}</p>
                      )}
                    </TD>
                    <TD className="tabular text-right">
                      {e.size !== null ? formatStorage(e.size) : '—'}
                    </TD>
                    <TD className="text-right">
                      {e.status === 'ready' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => download.mutate(e.id)}
                          loading={download.isPending && download.variables === e.id}
                        >
                          <Download aria-hidden />
                          Download
                        </Button>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- Google Drive

export function DriveCard({ orgId, data }: { orgId: string; data: MerchantBackups }) {
  const qc = useQueryClient();
  const drive = data.drive;
  const [disconnecting, setDisconnecting] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: merchantBackupKeys.all(orgId) });
  const connect = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/orgs/${orgId}/backups/drive/connect`, { method: 'POST' }),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const update = useMutation({
    mutationFn: (body: { enabled?: boolean; keep?: number }) =>
      api<DriveConnection>(`/orgs/${orgId}/backups/drive`, { method: 'PATCH', body }),
    onSuccess: async () => {
      toast.success('Saved');
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const copy = useMutation({
    mutationFn: () => api(`/orgs/${orgId}/backups/drive/copy`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success('Saving a copy to Google Drive now.');
      setTimeout(() => void refresh(), 2500);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card data-testid="drive-card">
      <CardHeader className="space-y-1">
        <CardTitle>Daily copy to Google Drive</CardTitle>
        <CardDescription>
          Every night at 04:00 Sellora saves the same ZIP as &ldquo;Download your data&rdquo; to a
          folder in your Google Drive, and keeps the newest copies. Sellora can see only the files
          it makes there, never the rest of your Drive.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!data.driveModule ? (
          <Alert tone="info">
            Daily Google Drive copies are in the Commerce, Growth and All-in-one plans.{' '}
            <Link className="font-medium underline" href={`/app/${orgId}/billing`}>
              See plans
            </Link>
          </Alert>
        ) : !data.driveConfigured ? (
          <Alert tone="info">Google Drive is not set up on this server yet.</Alert>
        ) : !drive ? (
          <div>
            <Button onClick={() => connect.mutate()} loading={connect.isPending}>
              <Cloud aria-hidden />
              Connect Google Drive
            </Button>
          </div>
        ) : (
          <>
            {drive.status === 'reconnect' && (
              <Alert tone="warning">
                Google no longer lets Sellora save copies to {drive.email}: the access was removed
                or has expired. Connect again to keep daily copies going.
              </Alert>
            )}
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="text-muted-foreground">Google account</dt>
              <dd className="font-medium" data-testid="drive-email">
                {drive.email || '—'}
              </dd>
              <dt className="text-muted-foreground">Folder</dt>
              <dd>{drive.folderName}</dd>
              <dt className="text-muted-foreground">Last copy</dt>
              <dd data-testid="drive-last">
                {drive.copying
                  ? 'Saving a copy now…'
                  : drive.lastFile
                    ? `${drive.lastFile.name} · ${formatStorage(drive.lastFile.size)} · ${formatRelative(drive.lastFile.at)}`
                    : 'None yet'}
              </dd>
              {drive.lastError && (
                <>
                  <dt className="text-muted-foreground">Last problem</dt>
                  <dd className="text-destructive">
                    {drive.lastError}
                    {drive.lastAttemptAt && ` (${formatRelative(drive.lastAttemptAt)})`}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">Connected</dt>
              <dd>
                {formatDateTime(drive.connectedAt)}
                {drive.connectedBy && ` by ${drive.connectedBy}`}
              </dd>
            </dl>
            {drive.status === 'connected' ? (
              <div className="flex flex-wrap items-end gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={drive.enabled}
                    onCheckedChange={(enabled) => update.mutate({ enabled })}
                    aria-label="Daily copy"
                  />
                  Daily copy
                </label>
                <Field label="Copies kept" htmlFor="drive-keep" className="w-36">
                  <NativeSelect
                    id="drive-keep"
                    value={drive.keep}
                    onChange={(e) => update.mutate({ keep: Number(e.target.value) })}
                  >
                    {[...new Set([3, 5, 7, 14, 30, drive.keep])]
                      .sort((x, y) => x - y)
                      .map((n) => (
                        <option key={n} value={n}>
                          {n} copies
                        </option>
                      ))}
                  </NativeSelect>
                </Field>
                <Button
                  variant="outline"
                  onClick={() => copy.mutate()}
                  loading={copy.isPending}
                  disabled={drive.copying}
                >
                  <Cloud aria-hidden />
                  Copy now
                </Button>
                <Button variant="ghost" onClick={() => setDisconnecting(true)}>
                  <Unplug aria-hidden />
                  Disconnect
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => connect.mutate()} loading={connect.isPending}>
                  <Cloud aria-hidden />
                  Connect Google Drive again
                </Button>
                <Button variant="ghost" onClick={() => setDisconnecting(true)}>
                  Disconnect
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
      {disconnecting && drive && (
        <DisconnectDialog
          orgId={orgId}
          drive={drive}
          onClose={() => setDisconnecting(false)}
          onDone={refresh}
        />
      )}
    </Card>
  );
}

function DisconnectDialog({
  orgId,
  drive,
  onClose,
  onDone,
}: {
  orgId: string;
  drive: DriveConnection;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const go = useMutation({
    mutationFn: () => api(`/orgs/${orgId}/backups/drive`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('Google Drive disconnected');
      onClose();
      await onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Disconnect Google Drive?"
        description={`Sellora stops saving copies to ${drive.email || 'this Google account'} and gives up its access. The copies already in "${drive.folderName}" stay in your Drive.`}
      >
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => go.mutate()} loading={go.isPending}>
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- restore points and restoring

export function RestoreCard({
  orgId,
  name,
  data,
}: {
  orgId: string;
  name: string;
  data: MerchantBackups;
}) {
  const qc = useQueryClient();
  const ready = data.points.filter((p) => p.status === 'ready');
  const making = data.points.some((p) => p.status === 'making');
  const [runId, setRunId] = useState('');
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [parts, setParts] = useState<RestorePart[]>([]);
  const [restoring, setRestoring] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: merchantBackupKeys.all(orgId) });

  const point = useMutation({
    mutationFn: () => api(`/orgs/${orgId}/backups/restore-points`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success('Making a restore point. It is ready in a minute.');
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const look = useMutation({
    mutationFn: (id: string) =>
      api<RestorePreview>(`/orgs/${orgId}/backups/preview`, {
        method: 'POST',
        body: { runId: id },
      }),
    onSuccess: (p) => {
      setPreview(p);
      setParts([]);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const chosen = runId || ready[0]?.id || '';
  const going = data.restores.some((r) => r.status === 'running');

  return (
    <Card data-testid="restore-card">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>Restore points</CardTitle>
          <CardDescription>
            Put back products, customers, orders or other parts as they were at a restore point, for
            example after deleting something by mistake. A safety copy is made first, so a restore
            can be undone. Make a restore point before a big change; the newest 3 are kept.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          onClick={() => point.mutate()}
          loading={point.isPending}
          disabled={making}
        >
          <History aria-hidden />
          {making ? 'Making a restore point…' : 'Make a restore point'}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5">
        {ready.length === 0 ? (
          <EmptyState icon={History} title="No restore point yet">
            Sellora&rsquo;s nightly backup makes one each night, or make one now.
          </EmptyState>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Restore point" htmlFor="restore-point" className="min-w-72 flex-1">
              <NativeSelect
                id="restore-point"
                value={chosen}
                onChange={(e) => {
                  setRunId(e.target.value);
                  setPreview(null);
                }}
              >
                {ready.map((p) => (
                  <option key={p.id} value={p.id}>
                    {pointLabel(p)}
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
            <RestorePreviewTable preview={preview} parts={parts} onChange={setParts} />
            <div>
              <Button
                variant="destructive"
                disabled={parts.length === 0 || going}
                onClick={() => setRestoring(true)}
              >
                <RotateCcw aria-hidden />
                Restore {parts.length ? partsLabel(parts, data.parts) : 'selected parts'}…
              </Button>
            </div>
          </div>
        )}

        {data.restores.length > 0 && (
          <div className="grid gap-2">
            <h4 className="text-sm font-medium">Restores</h4>
            <Table data-testid="restores">
              <THead>
                <TR>
                  <TH>Started</TH>
                  <TH>Parts</TH>
                  <TH>Status</TH>
                  <TH>Reason</TH>
                </TR>
              </THead>
              <TBody>
                {data.restores.map((r) => {
                  const s = RESTORE_STATUS[r.status];
                  const written = Object.values(r.restored).reduce((n, x) => n + x, 0);
                  return (
                    <TR key={r.id}>
                      <TD>
                        <div>{formatDateTime(r.startedAt)}</div>
                        {r.by.label && (
                          <div className="text-[13px] text-muted-foreground">{r.by.label}</div>
                        )}
                      </TD>
                      <TD>{partsLabel(r.parts, data.parts)}</TD>
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
                        {r.safetyRunId &&
                          r.status !== 'running' &&
                          ready.some((p) => p.id === r.safetyRunId) && (
                            <Button
                              variant="link"
                              size="sm"
                              className="text-[13px]"
                              onClick={() => {
                                setRunId(r.safetyRunId!);
                                look.mutate(r.safetyRunId!);
                              }}
                            >
                              Undo: see the safety copy
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
        <OwnerRestoreDialog
          orgId={orgId}
          name={name}
          preview={preview}
          parts={parts}
          catalogue={data.parts}
          onClose={() => setRestoring(false)}
          onDone={async () => {
            setPreview(null);
            setParts([]);
            await refresh();
          }}
        />
      )}
    </Card>
  );
}

function OwnerRestoreDialog({
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
  catalogue: MerchantBackups['parts'];
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const removed = preview.parts
    .filter((p) => parts.includes(p.part))
    .reduce((n, p) => n + p.removed, 0);
  const restore = useMutation({
    mutationFn: () =>
      api(`/orgs/${orgId}/backups/restores`, {
        method: 'POST',
        body: { runId: preview.run.id, parts, reason: reason.trim(), confirmName, password },
      }),
    onSuccess: async () => {
      toast.success('Restore started. You get an email when it is done.');
      onClose();
      await onDone();
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      toast.error(errorMessage(err));
    },
  });
  const label = partsLabel(parts, catalogue);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Restore ${label}?`}
        description={`Your ${label.toLowerCase()} become as they were on ${formatDateTime(preview.run.startedAt)}.`}
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
              safety copy.
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
            label={`Type your business's name: ${name}`}
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
          <Field label="Your password" htmlFor="restore-password" error={errors.password}>
            <Input
              id="restore-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={restore.isPending}
              disabled={reason.trim().length < 5 || confirmName.trim() !== name.trim() || !password}
            >
              Restore
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Says once what happened on Google's page, from the `drive` query value it sent back. */
export function useDriveResult() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('drive');
    if (!result) return;
    const r = DRIVE_RESULT[result];
    if (r) (r.ok ? toast.success : toast.error)(r.text);
    url.searchParams.delete('drive');
    window.history.replaceState(null, '', url.toString());
  }, []);
}
