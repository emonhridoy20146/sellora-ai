import { describe, expect, it } from 'vitest';
import {
  dayKey,
  lastDayKeys,
  startOfDayInZone,
  startOfMonthInZone,
  zonedParts,
  zonedTimeToUtc,
} from './zoned.js';

describe('zoned time helpers', () => {
  it('reads the wall clock in a time zone', () => {
    // 2026-10-31 20:30 UTC is 2026-11-01 02:30 in Dhaka (UTC+6).
    const p = zonedParts(new Date('2026-10-31T20:30:00Z'), 'Asia/Dhaka');
    expect(p).toMatchObject({ year: 2026, month: 11, day: 1, hour: 2, minute: 30 });
  });

  it('starts the month by the merchant calendar, not UTC', () => {
    const at = new Date('2026-10-31T20:30:00Z'); // already November in Dhaka
    expect(startOfMonthInZone(at, 'Asia/Dhaka').toISOString()).toBe('2026-10-31T18:00:00.000Z');
    expect(startOfMonthInZone(at, 'UTC').toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('starts the day in the zone', () => {
    const at = new Date('2026-03-15T03:00:00Z');
    expect(startOfDayInZone(at, 'Asia/Dhaka').toISOString()).toBe('2026-03-14T18:00:00.000Z');
    expect(startOfDayInZone(at, 'America/New_York').toISOString()).toBe('2026-03-14T04:00:00.000Z');
  });

  it('handles daylight saving changes', () => {
    // New York moves to UTC-4 on 2026-03-08; midnight that day is still UTC-5.
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8 }, 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 9 }, 'America/New_York').toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
    // London month start in summer time.
    expect(
      startOfMonthInZone(new Date('2026-07-15T12:00:00Z'), 'Europe/London').toISOString(),
    ).toBe('2026-06-30T23:00:00.000Z');
  });

  it('names days by the merchant calendar and lists the last few, oldest first', () => {
    const at = new Date('2026-10-31T20:30:00Z'); // 1 November in Dhaka
    expect(dayKey(at, 'Asia/Dhaka')).toBe('2026-11-01');
    expect(dayKey(at, 'UTC')).toBe('2026-10-31');
    expect(dayKey(at, 'Not/AZone')).toBe('2026-10-31');
    expect(lastDayKeys(3, 'Asia/Dhaka', at)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });
});
