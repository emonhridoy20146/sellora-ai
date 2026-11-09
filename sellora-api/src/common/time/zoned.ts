/**
 * Calendar boundaries in a business's own time zone. Monthly plan limits and daily
 * reports count by the merchant's calendar, not UTC, so an order placed at 01:00 in Dhaka
 * on the 1st counts toward the new month.
 */

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock date and time in `timeZone` at the instant `at`. */
export function zonedParts(at: Date, timeZone: string): CalendarParts {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)!.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Milliseconds `timeZone` is ahead of UTC at the instant `at`. */
function offsetMs(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in `timeZone`. */
export function zonedTimeToUtc(
  wall: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0);
  const first = offsetMs(new Date(guess), timeZone);
  const candidate = guess - first;
  // Across a DST change the offset at the answer can differ from the offset at the guess.
  const second = offsetMs(new Date(candidate), timeZone);
  return new Date(second === first ? candidate : guess - second);
}

export function startOfDayInZone(at: Date, timeZone: string): Date {
  const p = zonedParts(at, timeZone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, timeZone);
}

export function startOfMonthInZone(at: Date, timeZone: string): Date {
  const p = zonedParts(at, timeZone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: 1 }, timeZone);
}

/** The calendar day (YYYY-MM-DD) of `at` in `timeZone`; UTC when the zone is unknown. */
export function dayKey(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** The last `days` calendar days in `timeZone`, oldest first, ending today. */
export function lastDayKeys(days: number, timeZone: string, now = new Date()): string[] {
  return Array.from({ length: days }, (_, i) =>
    dayKey(new Date(now.getTime() - (days - 1 - i) * 86_400_000), timeZone),
  );
}
