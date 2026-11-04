/** Calendar day (YYYY-MM-DD) of an instant in a time zone. */
export function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Every calendar day between two instants (in the business's time zone), so a chart shows
 * quiet days as zero instead of skipping them.
 */
export function daysBetween(fromIso: string, toIso: string, timeZone: string): string[] {
  const out: string[] = [];
  const end = new Date(toIso).getTime();
  for (let t = new Date(fromIso).getTime(); t < end; t += 3_600_000) {
    const k = dayKey(new Date(t), timeZone);
    if (out.at(-1) !== k) out.push(k);
  }
  return out;
}

export function shortDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(Date.UTC(y!, m! - 1, d!));
}

export function longDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(y!, m! - 1, d!));
}

export function rangeFromDays(days: number, now = Date.now()): { from: string; to: string } {
  return { from: new Date(now - days * 86_400_000).toISOString(), to: new Date(now).toISOString() };
}
