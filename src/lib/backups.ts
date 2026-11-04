import type { BadgeTone } from '@/components/ui/badge';
import type { BackupRestore, BackupRun, BackupSettings } from '@/lib/api/types';

/** Backups (ADR 0020): labels and the small rules the pages show. */

export const RUN_STATUS: Record<BackupRun['status'], { label: string; tone: BadgeTone }> = {
  running: { label: 'Being made', tone: 'info' },
  verifying: { label: 'Checking', tone: 'info' },
  verified: { label: 'Verified', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  deleted: { label: 'Removed', tone: 'neutral' },
};

export const RUN_REASON: Record<BackupRun['reason'], string> = {
  scheduled: 'Nightly',
  manual: 'Asked for',
  safety: 'Safety copy',
  merchant: "Merchant's copy",
};

export const RESTORE_STATUS: Record<BackupRestore['status'], { label: string; tone: BadgeTone }> = {
  running: { label: 'Restoring', tone: 'info' },
  done: { label: 'Restored', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** Whether a page showing these should keep checking for changes. */
export function anyInProgress(runs: BackupRun[], restores: BackupRestore[] = []): boolean {
  return (
    runs.some((r) => r.status === 'running' || r.status === 'verifying' || r.testRestorePending) ||
    restores.some((r) => r.status === 'running')
  );
}

/** "03:00" for an hour of the day. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** The next time the nightly backup is due, as an instant: `hour` o'clock in `timeZone`. */
export function nextNightly(now: Date, s: Pick<BackupSettings, 'hour' | 'timezone'>): Date {
  // The wall clock in the time zone, then step forward to the hour (time zones with no
  // daylight saving, such as Dhaka, are exact; others can be an hour out on change days).
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: s.timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const secondsToday = get('hour') * 3600 + get('minute') * 60 + get('second');
  let wait = s.hour * 3600 - secondsToday;
  if (wait <= 0) wait += 24 * 3600;
  return new Date(Math.floor(now.getTime() / 1000) * 1000 + wait * 1000);
}

/** The newest verified platform backup. */
export function lastVerified(runs: BackupRun[]): BackupRun | null {
  return (
    runs
      .filter((r) => r.scope === 'platform' && r.status === 'verified')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null
  );
}

/** Bytes kept in storage by verified backups. */
export function keptBytes(runs: BackupRun[]): number {
  return runs.filter((r) => r.status === 'verified').reduce((n, r) => n + (r.size ?? 0), 0);
}

/** "Products, Orders" */
export function partsLabel(parts: string[], catalogue: { part: string; label: string }[]): string {
  return parts.map((p) => catalogue.find((c) => c.part === p)?.label ?? p).join(', ');
}

/** "2 m 05 s", "850 ms" */
export function durationLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
}
