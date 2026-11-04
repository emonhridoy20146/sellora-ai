import { describe, expect, it } from 'vitest';
import type { BackupRestore, BackupRun } from './api/types';
import {
  anyInProgress,
  durationLabel,
  hourLabel,
  keptBytes,
  lastVerified,
  nextNightly,
  partsLabel,
} from './backups';

const run = (over: Partial<BackupRun>): BackupRun => ({
  id: 'r',
  scope: 'platform',
  orgId: null,
  reason: 'scheduled',
  status: 'verified',
  tiers: ['daily'],
  size: 100,
  sha256: null,
  docs: 1,
  counts: {},
  startedAt: '2026-11-04T21:00:00.000Z',
  finishedAt: null,
  verifiedAt: null,
  durationMs: null,
  error: null,
  testRestore: null,
  testRestorePending: false,
  offsite: null,
  startedBy: null,
  ...over,
});

describe('backups', () => {
  it('finds the next nightly time in the time zone', () => {
    // 02:00 in Dhaka (20:00 UTC): next 03:00 is in one hour.
    expect(
      nextNightly(new Date('2026-11-03T20:00:00Z'), { hour: 3, timezone: 'Asia/Dhaka' }),
    ).toEqual(new Date('2026-11-03T21:00:00Z'));
    // 03:30 in Dhaka: tomorrow.
    expect(
      nextNightly(new Date('2026-11-03T21:30:00Z'), { hour: 3, timezone: 'Asia/Dhaka' }),
    ).toEqual(new Date('2026-11-04T21:00:00Z'));
    // Exactly at the hour: the next day's.
    expect(
      nextNightly(new Date('2026-11-03T21:00:00Z'), { hour: 3, timezone: 'Asia/Dhaka' }),
    ).toEqual(new Date('2026-11-04T21:00:00Z'));
  });

  it('keeps checking while anything is going', () => {
    expect(anyInProgress([run({})])).toBe(false);
    expect(anyInProgress([run({ status: 'verifying' })])).toBe(true);
    expect(anyInProgress([run({ testRestorePending: true })])).toBe(true);
    expect(anyInProgress([], [{ status: 'running' } as BackupRestore])).toBe(true);
  });

  it('picks the newest verified platform backup and adds up what is kept', () => {
    const runs = [
      run({ id: 'a', startedAt: '2026-11-01T21:00:00.000Z', size: 10 }),
      run({ id: 'b', startedAt: '2026-11-03T21:00:00.000Z', size: 20 }),
      run({ id: 'c', startedAt: '2026-11-04T21:00:00.000Z', status: 'failed', size: null }),
      run({ id: 'd', startedAt: '2026-11-05T21:00:00.000Z', scope: 'tenant', size: 5 }),
    ];
    expect(lastVerified(runs)?.id).toBe('b');
    expect(keptBytes(runs)).toBe(35);
    expect(lastVerified([])).toBeNull();
  });

  it('labels hours, parts and durations', () => {
    expect(hourLabel(3)).toBe('03:00');
    expect(hourLabel(23)).toBe('23:00');
    const catalogue = [
      { part: 'products' as const, label: 'Products', collections: [] },
      { part: 'orders' as const, label: 'Orders', collections: [] },
    ];
    expect(partsLabel(['products', 'orders'], catalogue)).toBe('Products, Orders');
    expect(durationLabel(850)).toBe('850 ms');
    expect(durationLabel(42_000)).toBe('42 s');
    expect(durationLabel(125_000)).toBe('2 m 05 s');
    expect(durationLabel(null)).toBe('—');
  });
});
