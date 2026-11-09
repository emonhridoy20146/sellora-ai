import type { AnalyticsOverview } from '@/lib/api/types';
import { daysBetween } from '@/lib/series';

/** "about 6 hours", "45 minutes": time saved, rounded the way people say it. */
export function timeSaved(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  const rounded = hours < 10 ? Math.round(hours * 2) / 2 : Math.round(hours);
  return `about ${rounded} hour${rounded === 1 ? '' : 's'}`;
}

/** "28 s", "4 min", "2 h 5 min": how long a reply took. */
export function replyTime(seconds: number | null): string {
  if (seconds === null) return '–';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Sales from AI orders for each 1 spent on AI credits, or null when either side is zero.
 * Rounded down to one decimal so it never overstates.
 */
export function salesPerAiSpend(ordersMinor: number, spentMinor: number): number | null {
  if (ordersMinor <= 0 || spentMinor <= 0) return null;
  return Math.floor((ordersMinor / spentMinor) * 10) / 10;
}

/** Sales and orders for every day of the period, quiet days as zero. */
export function salesDays(o: AnalyticsOverview) {
  const byDay = new Map(o.sales?.byDay.map((d) => [d.date, d]) ?? []);
  return daysBetween(o.range.from, o.range.to, o.range.timezone).map((key) => {
    const d = byDay.get(key);
    return {
      key,
      valueMinor: d?.valueMinor ?? 0,
      aiOrders: d?.aiOrders ?? 0,
      otherOrders: (d?.orders ?? 0) - (d?.aiOrders ?? 0),
    };
  });
}

/** Replies by the AI and by the team for every day of the period. */
export function replyDays(o: AnalyticsOverview) {
  const byDay = new Map(o.inbox?.byDay.map((d) => [d.date, d]) ?? []);
  return daysBetween(o.range.from, o.range.to, o.range.timezone).map((key) => ({
    key,
    aiReplies: byDay.get(key)?.aiReplies ?? 0,
    teamReplies: byDay.get(key)?.teamReplies ?? 0,
  }));
}

/** Share of a whole as a whole-number percentage, or null for an empty whole. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}
