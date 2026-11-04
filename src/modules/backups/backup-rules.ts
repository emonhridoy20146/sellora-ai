import { zonedParts, zonedTimeToUtc } from '../../common/time/zoned.js';

/** Backups (ADR 0020): the rules as pure functions, so they are tested without a database. */

export const BACKUP_TIERS = ['daily', 'weekly', 'monthly'] as const;
export type BackupTier = (typeof BACKUP_TIERS)[number];

export const DEFAULT_BACKUP_SETTINGS = {
  enabled: true,
  hour: 3,
  timezone: 'Asia/Dhaka',
  keep: { daily: 2, weekly: 1, monthly: 1 },
} as const;

/** A failed nightly backup is tried again after this long, at most this many times a day. */
export const RETRY_AFTER_MS = 30 * 60_000;
export const MAX_ATTEMPTS_PER_DAY = 3;
/** A run that has not moved for this long is taken as interrupted (the worker crashed). */
export const RUN_LEASE_MS = 30 * 60_000;
/** A restore still going after this long is taken as interrupted. */
export const RESTORE_LEASE_MS = 2 * 3600_000;
/** Safety backups taken before a restore are kept this long. */
export const SAFETY_KEEP_MS = 30 * 24 * 3600_000;
/** Run records stay this long after their file is deleted. */
export const RECORD_KEEP_MS = 365 * 24 * 3600_000;

/**
 * Parts of a business that can be restored on their own, and the collections each covers.
 * Money, the audit log, staff access, SMS opt-outs, credentials and message logs are never
 * restored per business (see ADR 0020).
 */
export const RESTORE_PARTS = {
  products: { label: 'Products', collections: ['products', 'categories', 'stockmovements'] },
  customers: { label: 'Customers', collections: ['customers'] },
  orders: { label: 'Orders', collections: ['orders', 'parcels'] },
  conversations: {
    label: 'Conversations',
    collections: ['conversations', 'messages', 'contacts'],
  },
  landing_pages: {
    label: 'Landing pages',
    collections: ['landing_pages', 'landing_page_versions'],
  },
  settings: {
    label: 'Settings',
    collections: [
      'shopsettings',
      'ai_agent_settings',
      'cartsettings',
      'automationsettings',
      'fraudsettings',
    ],
  },
} as const;
export type RestorePart = keyof typeof RESTORE_PARTS;
export const RESTORE_PART_KEYS = Object.keys(RESTORE_PARTS) as RestorePart[];

/** The most recent nightly slot (`hour` o'clock in `timeZone`) at or before `now`. */
export function scheduledSlot(now: Date, hour: number, timeZone: string): Date {
  const p = zonedParts(now, timeZone);
  const today = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour }, timeZone);
  if (today.getTime() <= now.getTime()) return today;
  // Yesterday: step back a day from noon (safe across daylight-saving changes).
  const noon = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 12 }, timeZone);
  const y = zonedParts(new Date(noon.getTime() - 24 * 3600_000), timeZone);
  return zonedTimeToUtc({ year: y.year, month: y.month, day: y.day, hour }, timeZone);
}

export type RunStatus = 'running' | 'verifying' | 'verified' | 'failed' | 'deleted';

/**
 * Whether the nightly backup should start now, given the scheduled runs started since the
 * last slot: none yet, or only failures, the last one more than 30 minutes ago, fewer than 3.
 */
export function nightlyDue(
  now: Date,
  sinceSlot: { startedAt: Date; status: RunStatus }[],
): boolean {
  if (sinceSlot.some((r) => r.status !== 'failed')) return false;
  if (sinceSlot.length >= MAX_ATTEMPTS_PER_DAY) return false;
  const last = Math.max(0, ...sinceSlot.map((r) => r.startedAt.getTime()));
  return !last || now.getTime() - last >= RETRY_AFTER_MS;
}

function dayKey(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const p = zonedParts(at, timeZone);
  return { y: p.year, m: p.month, d: p.day };
}

/** Monday of the week `at` falls in, in `timeZone`, as YYYY-MM-DD. */
export function weekKey(at: Date, timeZone: string): string {
  const { y, m, d } = dayKey(at, timeZone);
  const date = new Date(Date.UTC(y, m - 1, d));
  const back = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

export function monthKey(at: Date, timeZone: string): string {
  const { y, m } = dayKey(at, timeZone);
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * The tiers a newly verified platform backup takes: always daily; weekly when no verified
 * backup of the same week is the weekly copy yet; monthly likewise for the month.
 */
export function tiersFor(
  at: Date,
  timeZone: string,
  verified: { startedAt: Date; tiers: readonly BackupTier[] }[],
): BackupTier[] {
  const tiers: BackupTier[] = ['daily'];
  const week = weekKey(at, timeZone);
  const month = monthKey(at, timeZone);
  if (!verified.some((r) => r.tiers.includes('weekly') && weekKey(r.startedAt, timeZone) === week))
    tiers.push('weekly');
  if (
    !verified.some((r) => r.tiers.includes('monthly') && monthKey(r.startedAt, timeZone) === month)
  )
    tiers.push('monthly');
  return tiers;
}

/**
 * Which verified platform backups to keep: the newest `daily`, the newest `weekly` that are
 * weekly copies and the newest `monthly` that are monthly copies. The rest are removed.
 */
export function planRetention<
  R extends { id: string; startedAt: Date; tiers: readonly BackupTier[] },
>(
  verified: R[],
  keep: { daily: number; weekly: number; monthly: number },
): { keep: R[]; remove: R[] } {
  const newest = [...verified].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  const ids = new Set<string>();
  for (const r of newest.slice(0, Math.max(1, keep.daily))) ids.add(r.id);
  for (const r of newest.filter((x) => x.tiers.includes('weekly')).slice(0, keep.weekly))
    ids.add(r.id);
  for (const r of newest.filter((x) => x.tiers.includes('monthly')).slice(0, keep.monthly))
    ids.add(r.id);
  return {
    keep: newest.filter((r) => ids.has(r.id)),
    remove: newest.filter((r) => !ids.has(r.id)),
  };
}

/** What a restore of one collection would do, from the ids in the backup and now. */
export function diffIds(backup: Set<string>, current: Set<string>) {
  let added = 0;
  let replaced = 0;
  for (const id of backup)
    if (current.has(id)) replaced += 1;
    else added += 1;
  let removed = 0;
  for (const id of current) if (!backup.has(id)) removed += 1;
  return { inBackup: backup.size, now: current.size, added, replaced, removed };
}
