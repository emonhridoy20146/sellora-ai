import { describe, expect, it } from 'vitest';
import {
  diffIds,
  monthKey,
  nightlyDue,
  planRetention,
  scheduledSlot,
  tiersFor,
  weekKey,
  type BackupTier,
} from './backup-rules.js';

const DHAKA = 'Asia/Dhaka'; // UTC+6, no daylight saving
const at = (iso: string) => new Date(iso);

describe('scheduledSlot', () => {
  it('is today at the hour once the hour has passed, in the business time zone', () => {
    // 03:30 in Dhaka on 4 Nov = 21:30 UTC on 3 Nov.
    expect(scheduledSlot(at('2026-11-03T21:30:00Z'), 3, DHAKA)).toEqual(at('2026-11-03T21:00:00Z'));
  });

  it('is yesterday at the hour before the hour', () => {
    // 02:00 in Dhaka on 4 Nov: the slot is 03:00 on 3 Nov (21:00 UTC on 2 Nov).
    expect(scheduledSlot(at('2026-11-03T20:00:00Z'), 3, DHAKA)).toEqual(at('2026-11-02T21:00:00Z'));
  });

  it('is exact at the hour', () => {
    expect(scheduledSlot(at('2026-11-03T21:00:00Z'), 3, DHAKA)).toEqual(at('2026-11-03T21:00:00Z'));
  });

  it('copes with a daylight saving change', () => {
    // London moved to BST at 01:00 UTC on 29 Mar 2026; 03:00 BST is 02:00 UTC.
    expect(scheduledSlot(at('2026-03-29T12:00:00Z'), 3, 'Europe/London')).toEqual(
      at('2026-03-29T02:00:00Z'),
    );
    // Just before 03:00 BST on 30 Mar the slot is still the 29th.
    expect(scheduledSlot(at('2026-03-30T01:59:00Z'), 3, 'Europe/London')).toEqual(
      at('2026-03-29T02:00:00Z'),
    );
  });
});

describe('nightlyDue', () => {
  const now = at('2026-11-04T00:00:00Z');
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);

  it('is due when nothing ran since the slot', () => {
    expect(nightlyDue(now, [])).toBe(true);
  });

  it('is not due once a backup since the slot is running or succeeded', () => {
    expect(nightlyDue(now, [{ startedAt: ago(90), status: 'verified' }])).toBe(false);
    expect(nightlyDue(now, [{ startedAt: ago(5), status: 'running' }])).toBe(false);
    expect(nightlyDue(now, [{ startedAt: ago(5), status: 'verifying' }])).toBe(false);
    expect(
      nightlyDue(now, [
        { startedAt: ago(120), status: 'failed' },
        { startedAt: ago(60), status: 'verified' },
      ]),
    ).toBe(false);
  });

  it('retries a failure after 30 minutes, at most three times', () => {
    expect(nightlyDue(now, [{ startedAt: ago(10), status: 'failed' }])).toBe(false);
    expect(nightlyDue(now, [{ startedAt: ago(30), status: 'failed' }])).toBe(true);
    expect(
      nightlyDue(now, [
        { startedAt: ago(100), status: 'failed' },
        { startedAt: ago(40), status: 'failed' },
      ]),
    ).toBe(true);
    expect(
      nightlyDue(now, [
        { startedAt: ago(150), status: 'failed' },
        { startedAt: ago(100), status: 'failed' },
        { startedAt: ago(40), status: 'failed' },
      ]),
    ).toBe(false);
  });
});

describe('week and month keys', () => {
  it('weeks start on Monday in the time zone', () => {
    // Sunday 8 Nov 2026 23:30 in Dhaka is still the week of Monday 2 Nov.
    expect(weekKey(at('2026-11-08T17:30:00Z'), DHAKA)).toBe('2026-11-02');
    // Monday 9 Nov 00:30 in Dhaka (18:30 UTC on Sunday) is the next week.
    expect(weekKey(at('2026-11-08T18:30:00Z'), DHAKA)).toBe('2026-11-09');
  });

  it('months follow the time zone', () => {
    expect(monthKey(at('2026-11-30T18:30:00Z'), DHAKA)).toBe('2026-12');
    expect(monthKey(at('2026-11-30T17:30:00Z'), DHAKA)).toBe('2026-11');
  });
});

describe('tiersFor', () => {
  const v = (iso: string, tiers: BackupTier[]) => ({ startedAt: at(iso), tiers });

  it('the first backup is daily, weekly and monthly', () => {
    expect(tiersFor(at('2026-11-04T21:00:00Z'), DHAKA, [])).toEqual(['daily', 'weekly', 'monthly']);
  });

  it('later backups in the same week and month are only daily', () => {
    expect(
      tiersFor(at('2026-11-05T21:00:00Z'), DHAKA, [
        v('2026-11-04T21:00:00Z', ['daily', 'weekly', 'monthly']),
      ]),
    ).toEqual(['daily']);
  });

  it('a new week gets a weekly copy; a new month a monthly copy', () => {
    const history = [v('2026-11-04T21:00:00Z', ['daily', 'weekly', 'monthly'])];
    expect(tiersFor(at('2026-11-09T21:00:00Z'), DHAKA, history)).toEqual(['daily', 'weekly']);
    expect(tiersFor(at('2026-12-01T21:00:00Z'), DHAKA, history)).toEqual([
      'daily',
      'weekly',
      'monthly',
    ]);
  });

  it('a week whose weekly copy was only daily still gets one', () => {
    expect(
      tiersFor(at('2026-11-05T21:00:00Z'), DHAKA, [v('2026-11-04T21:00:00Z', ['daily'])]),
    ).toEqual(['daily', 'weekly', 'monthly']);
  });
});

describe('planRetention', () => {
  const r = (id: string, day: number, tiers: BackupTier[]) => ({
    id,
    startedAt: at(`2026-11-${String(day).padStart(2, '0')}T21:00:00Z`),
    tiers,
  });

  it('keeps the newest dailies, the newest weekly and the newest monthly', () => {
    const runs = [
      r('a', 1, ['daily', 'weekly', 'monthly']),
      r('b', 2, ['daily']),
      r('c', 3, ['daily']),
      r('d', 9, ['daily', 'weekly']),
      r('e', 10, ['daily']),
      r('f', 11, ['daily']),
    ];
    const plan = planRetention(runs, { daily: 2, weekly: 1, monthly: 1 });
    expect(plan.keep.map((x) => x.id)).toEqual(['f', 'e', 'd', 'a']);
    expect(plan.remove.map((x) => x.id)).toEqual(['c', 'b']);
  });

  it('a backup that is several tiers is kept once', () => {
    const plan = planRetention([r('a', 1, ['daily', 'weekly', 'monthly'])], {
      daily: 2,
      weekly: 1,
      monthly: 1,
    });
    expect(plan.keep.map((x) => x.id)).toEqual(['a']);
    expect(plan.remove).toEqual([]);
  });

  it('always keeps the newest backup, even with daily set to 0', () => {
    const plan = planRetention([r('a', 1, ['daily']), r('b', 2, ['daily'])], {
      daily: 0,
      weekly: 0,
      monthly: 0,
    });
    expect(plan.keep.map((x) => x.id)).toEqual(['b']);
  });
});

describe('diffIds', () => {
  it('counts what a restore adds, replaces and removes', () => {
    expect(diffIds(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd', 'e']))).toEqual({
      inBackup: 3,
      now: 4,
      added: 1,
      replaced: 2,
      removed: 2,
    });
  });
});
