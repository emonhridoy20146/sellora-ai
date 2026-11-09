import { describe, expect, it } from 'vitest';
import type { AnalyticsOverview } from '@/lib/api/types';
import { replyDays, replyTime, salesDays, salesPerAiSpend, share, timeSaved } from './analytics';

const overview = (over: Partial<AnalyticsOverview> = {}): AnalyticsOverview => ({
  // 1 to 3 October in Dhaka.
  range: {
    from: '2026-09-30T18:00:00.000Z',
    to: '2026-10-03T18:00:00.000Z',
    timezone: 'Asia/Dhaka',
    currency: 'BDT',
  },
  value: { ai: null, carts: null, riskyOrders: null },
  inbox: null,
  sales: null,
  ...over,
});

describe('analytics labels', () => {
  it('says time saved the way people do', () => {
    expect(timeSaved(0)).toBe('0 minutes');
    expect(timeSaved(1)).toBe('1 minute');
    expect(timeSaved(45)).toBe('45 minutes');
    expect(timeSaved(60)).toBe('about 1 hour');
    expect(timeSaved(100)).toBe('about 1.5 hours');
    expect(timeSaved(6 * 60 + 50)).toBe('about 7 hours');
    expect(timeSaved(25 * 60)).toBe('about 25 hours');
  });

  it('says reply times in seconds, minutes and hours', () => {
    expect(replyTime(null)).toBe('–');
    expect(replyTime(28.4)).toBe('28 s');
    expect(replyTime(240)).toBe('4 min');
    expect(replyTime(2 * 3600 + 300)).toBe('2 h 5 min');
    expect(replyTime(3 * 3600)).toBe('3 h');
  });

  it('never overstates sales per taka spent on AI', () => {
    expect(salesPerAiSpend(250_000, 2_011)).toBe(124.3);
    expect(salesPerAiSpend(0, 2_011)).toBeNull();
    expect(salesPerAiSpend(250_000, 0)).toBeNull();
    expect(share(1, 3)).toBe(33);
    expect(share(0, 0)).toBeNull();
  });
});

describe('analytics series', () => {
  it('fills quiet days with zero, in the business’s time zone', () => {
    const o = overview({
      sales: {
        orders: 3,
        valueMinor: 400,
        averageMinor: 133,
        cancelled: 0,
        returned: 0,
        delivered: 0,
        bySource: [],
        byDay: [{ date: '2026-10-02', orders: 3, valueMinor: 400, aiOrders: 1 }],
        topProducts: [],
      },
    });
    expect(salesDays(o)).toEqual([
      { key: '2026-10-01', valueMinor: 0, aiOrders: 0, otherOrders: 0 },
      { key: '2026-10-02', valueMinor: 400, aiOrders: 1, otherOrders: 2 },
      { key: '2026-10-03', valueMinor: 0, aiOrders: 0, otherOrders: 0 },
    ]);
    expect(replyDays(o).map((d) => d.aiReplies)).toEqual([0, 0, 0]);
  });
});
