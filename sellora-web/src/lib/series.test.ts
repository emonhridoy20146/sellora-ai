import { describe, expect, it } from 'vitest';
import { niceTicks } from '@/components/charts/column-chart';
import { dayKey, daysBetween, shortDay } from './series';

describe('days', () => {
  it('uses the business time zone for the calendar day', () => {
    // 20:00 UTC is already the next day in Dhaka (UTC+6).
    expect(dayKey(new Date('2026-10-26T20:00:00Z'), 'Asia/Dhaka')).toBe('2026-10-27');
    expect(dayKey(new Date('2026-10-26T20:00:00Z'), 'UTC')).toBe('2026-10-26');
  });

  it('lists every day in a range, including quiet ones', () => {
    const days = daysBetween('2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z', 'UTC');
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-10-20');
    expect(days.at(-1)).toBe('2026-10-26');
    expect(shortDay('2026-10-27')).toBe('27 Oct');
  });
});

describe('niceTicks', () => {
  it('rounds the axis to clean steps that cover the maximum', () => {
    expect(niceTicks(277)).toEqual([0, 100, 200, 300]);
    expect(niceTicks(9)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(1000).at(-1)).toBeGreaterThanOrEqual(1000);
  });
});
