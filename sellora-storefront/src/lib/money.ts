import type { Language } from './types';

const formatters = new Map<string, Intl.NumberFormat>();

const exponents = new Map<string, number>();

/** How many minor units the currency has after the point (2 for taka: 100 poisha). */
export function currencyExponent(currency: string): number {
  let e = exponents.get(currency);
  if (e === undefined) {
    e =
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    exponents.set(currency, e);
  }
  return e;
}

/** "৳1,250" (or "১,২৫০৳" in Bangla). Shows the minor part only when there is one. */
export function formatMoney(minor: number, currency: string, language: Language): string {
  const exp = currencyExponent(currency);
  const scale = 10 ** exp;
  const digits = minor % scale === 0 ? 0 : exp;
  const key = `${currency}:${language}:${digits}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(language === 'bn' ? 'bn-BD' : 'en-BD', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formatters.set(key, f);
  }
  return f.format(minor / scale);
}

/** Digits in the shop's language. */
export function formatNumber(n: number, language: Language): string {
  return new Intl.NumberFormat(language === 'bn' ? 'bn-BD' : 'en-BD').format(n);
}

export function formatDate(iso: string, language: Language): string {
  return new Intl.DateTimeFormat(language === 'bn' ? 'bn-BD' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Dhaka',
  }).format(new Date(iso));
}
