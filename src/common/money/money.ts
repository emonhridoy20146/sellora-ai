/**
 * Money is always an integer number of minor units (paisa for BDT, cents for USD).
 * Floating point is never used for stored amounts.
 */
export interface CurrencyInfo {
  code: string;
  minorUnits: number;
  symbol: string;
}

export const CURRENCIES: Record<string, CurrencyInfo> = {
  BDT: { code: 'BDT', minorUnits: 2, symbol: '৳' },
  USD: { code: 'USD', minorUnits: 2, symbol: '$' },
  EUR: { code: 'EUR', minorUnits: 2, symbol: '€' },
  GBP: { code: 'GBP', minorUnits: 2, symbol: '£' },
  INR: { code: 'INR', minorUnits: 2, symbol: '₹' },
  PKR: { code: 'PKR', minorUnits: 2, symbol: 'Rs' },
  AED: { code: 'AED', minorUnits: 2, symbol: 'د.إ' },
  SAR: { code: 'SAR', minorUnits: 2, symbol: '﷼' },
  MYR: { code: 'MYR', minorUnits: 2, symbol: 'RM' },
  SGD: { code: 'SGD', minorUnits: 2, symbol: 'S$' },
  JPY: { code: 'JPY', minorUnits: 0, symbol: '¥' },
};

export function currencyInfo(code: string): CurrencyInfo {
  const info = CURRENCIES[code.toUpperCase()];
  if (!info) throw new Error(`Unsupported currency ${code}`);
  return info;
}

export function isSupportedCurrency(code: string): boolean {
  return code.toUpperCase() in CURRENCIES;
}

/** Parses a decimal string such as "1250.50" into minor units without float drift. */
export function toMinor(amount: string | number, currency: string): number {
  const { minorUnits } = currencyInfo(currency);
  const text = typeof amount === 'number' ? amount.toFixed(minorUnits) : amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid amount "${text}"`);
  const negative = text.startsWith('-');
  const [whole = '0', frac = ''] = text.replace('-', '').split('.');
  if (frac.length > minorUnits && /[1-9]/.test(frac.slice(minorUnits))) {
    throw new Error(`Amount "${text}" has more than ${minorUnits} decimals`);
  }
  const minor =
    Number(whole) * 10 ** minorUnits +
    Number((frac + '0'.repeat(minorUnits)).slice(0, minorUnits) || 0);
  if (!Number.isSafeInteger(minor)) throw new Error('Amount is too large');
  return negative ? -minor : minor;
}

export function fromMinor(minor: number, currency: string): string {
  const { minorUnits } = currencyInfo(currency);
  const negative = minor < 0;
  const abs = Math.abs(minor);
  if (minorUnits === 0) return `${negative ? '-' : ''}${abs}`;
  const div = 10 ** minorUnits;
  const whole = Math.floor(abs / div);
  const frac = String(abs % div).padStart(minorUnits, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export function formatMoney(minor: number, currency: string, locale = 'en'): string {
  const { minorUnits } = currencyInfo(currency);
  const value = Number(fromMinor(minor, currency));
  return new Intl.NumberFormat(locale === 'bn' ? 'bn-BD' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: minorUnits,
    maximumFractionDigits: minorUnits,
  }).format(value);
}

/**
 * Multiplies an amount by a rational factor and rounds half-up (away from zero) in
 * integer space. `numerator/denominator` is used instead of a float multiplier.
 */
export function mulDiv(amount: number, numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error('Division by zero');
  const product = BigInt(amount) * BigInt(numerator);
  const d = BigInt(denominator);
  const q = product / d;
  const r = product % d;
  const twice = (r < 0n ? -r : r) * 2n;
  const adj = twice >= (d < 0n ? -d : d) ? (product < 0n !== d < 0n ? -1n : 1n) : 0n;
  return Number(q + adj);
}

/** Splits `total` across weights so the parts always sum exactly to `total`. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error('Weights must sum to a positive number');
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % parts.length, remainder--) parts[i]! += 1;
  return parts;
}
