/**
 * Formatting for money, credits and dates. Money arrives as integers in the currency's minor
 * unit; the number of decimals comes from Intl, so BDT, USD and JPY all work.
 */

const fractionCache = new Map<string, number>();

export function minorDigits(currency: string): number {
  let d = fractionCache.get(currency);
  if (d === undefined) {
    try {
      d =
        new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      d = 2;
    }
    fractionCache.set(currency, d);
  }
  return d;
}

export function formatMoney(
  minor: number,
  currency: string,
  opts: { locale?: string; compact?: boolean; signed?: boolean } = {},
): string {
  const digits = minorDigits(currency);
  const major = minor / 10 ** digits;
  const fmt = new Intl.NumberFormat(opts.locale ?? 'en', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    notation: opts.compact ? 'compact' : 'standard',
    minimumFractionDigits: opts.compact ? 0 : Number.isInteger(major) ? 0 : digits,
    maximumFractionDigits: opts.compact ? 1 : digits,
    signDisplay: opts.signed ? 'exceptZero' : 'auto',
  });
  return fmt.format(major);
}

/**
 * Parses what a person typed ("1,499.50") into minor units without floating point error.
 * Returns null for anything that is not a plain positive amount.
 */
export function parseMoney(input: string, currency: string): number | null {
  const digits = minorDigits(currency);
  if (input.includes('-')) return null;
  const clean = input.replace(/[,\s]/g, '').replace(/^[^\d.]+/, '');
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(clean);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > digits) return null;
  return Number(m[1]) * 10 ** digits + Number(frac.padEnd(digits, '0') || '0');
}

export function minorToInput(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  const major = minor / 10 ** digits;
  return Number.isInteger(major) ? String(major) : major.toFixed(digits);
}

export function formatNumber(n: number, opts: { compact?: boolean; digits?: number } = {}): string {
  return new Intl.NumberFormat('en', {
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.digits ?? (opts.compact ? 1 : 2),
  }).format(n);
}

export function formatCredits(n: number): string {
  return `${formatNumber(n, { digits: 2 })} credit${n === 1 ? '' : 's'}`;
}

/** "0:07", "1:05": a recording's length the way phones show it. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatPercent(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return `${n.toFixed(digits)}%`;
}

export function formatDate(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '–';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '–';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const diff = (new Date(iso).getTime() - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return 'just now';
}

export function daysUntil(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - now) / (24 * 3600 * 1000));
}

/** "inbox_reply" -> "Inbox reply" */
export function humanize(key: string): string {
  const s = key.replace(/[_.-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Storage as plans describe it: limits are set in MB (1 MB = 1024 × 1024 bytes) and 1,000 MB
 * is shown as 1 GB, so a 100,000 MB plan reads "100 GB" and usage is measured the same way.
 */
export function formatStorage(bytes: number): string {
  const b = Math.max(0, bytes);
  if (b < 1024) return `${formatNumber(b, { digits: 0 })} bytes`;
  if (b < 1024 * 1024) return `${formatNumber(b / 1024, { digits: 1 })} KB`;
  const mb = b / (1024 * 1024);
  if (mb < 1000) return `${formatNumber(mb, { digits: mb < 10 ? 1 : 0 })} MB`;
  const gb = mb / 1000;
  return `${formatNumber(gb, { digits: gb < 10 ? 2 : gb < 100 ? 1 : 0 })} GB`;
}

/** A datetime-local input value in the browser's time zone for an ISO time ('' for none). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local input value back to an ISO time, or null when empty or not a time. */
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
