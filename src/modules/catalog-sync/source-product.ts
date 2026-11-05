import { createHash } from 'node:crypto';
import { currencyInfo } from '../../common/money/money.js';

/**
 * The one shape every catalog source is turned into (ADR 0023). Connectors build these from
 * their API or file; `normalizeSourceProduct` makes them fit Sellora's product rules or
 * says why one cannot be imported.
 */

export interface SourceVariant {
  externalId: string;
  optionValues: string[];
  sku?: string;
  barcode?: string;
  priceMinor: number;
  compareAtPriceMinor?: number;
  trackStock: boolean;
  stock: number;
  weightGrams?: number;
}

export interface SourceProduct {
  externalId: string;
  name: string;
  description: string;
  /** Inactive: a draft, archived or hidden product at the source. */
  active: boolean;
  tags: string[];
  category?: string;
  images: { url: string; alt?: string }[];
  options: { name: string; values: string[] }[];
  variants: SourceVariant[];
}

export interface SourceProblem {
  /** What the merchant recognises: a product name, a row number, a photo address. */
  ref: string;
  message: string;
}

/** Limits match the product API (commerce.dto.ts) so imported products can be edited. */
export const SOURCE_LIMITS = {
  name: 200,
  description: 20_000,
  tags: 30,
  tag: 40,
  category: 80,
  options: 3,
  optionName: 40,
  optionValues: 50,
  optionValue: 60,
  variants: 100,
  sku: 64,
  images: 8,
  imageUrl: 2000,
  imageAlt: 200,
  stock: 10_000_000,
  weightGrams: 1_000_000,
  /** Largest price: 100 crore in any currency's major unit. */
  priceMajor: 1_000_000_000,
} as const;

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Bangla digits as ASCII digits. */
export function asciiDigits(text: string): string {
  return text.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));
}

/**
 * A price as people write it in a sheet or as an API sends it: "1,250", "৳1,250", "Tk
 * 1250.00", "1250 টাকা", "১২৫০", 1250. Null when it is not a price. Commas are thousands
 * separators; one dot is the decimal point.
 */
export function parsePrice(value: unknown, currency: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    value = value.toFixed(currencyInfo(currency).minorUnits);
  }
  if (typeof value !== 'string') return null;
  let text = asciiDigits(value)
    .trim()
    .replace(/^(bdt|tk\.?|taka|usd|inr|rs\.?|৳|\$|€|£|₹)\s*/i, '')
    .replace(/\s*(bdt|tk\.?|taka|টাকা|\/-|৳)$/i, '')
    .replace(/[\s\u00a0]/g, '');
  if (!text) return null;
  if (/^\d{1,3}(,\d{2,3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const { minorUnits } = currencyInfo(currency);
  const [whole = '0', frac = ''] = text.split('.');
  if (Number(whole) > SOURCE_LIMITS.priceMajor) return null;
  // Rounds half up at the currency's precision (prices with more decimals are rare).
  const padded = (frac + '0'.repeat(minorUnits + 1)).slice(0, minorUnits + 1);
  const scaled = Number(whole) * 10 ** minorUnits + Number(padded.slice(0, minorUnits) || 0);
  const roundUp = Number(padded[minorUnits] ?? 0) >= 5 ? 1 : 0;
  const minor = scaled + roundUp;
  return Number.isSafeInteger(minor) ? minor : null;
}

/** A whole, non-negative count; null when it is not one. */
export function parseCount(value: unknown): number | null {
  if (typeof value === 'number')
    return Number.isInteger(value) ? Math.max(0, Math.min(value, SOURCE_LIMITS.stock)) : null;
  if (typeof value !== 'string') return null;
  const text = asciiDigits(value).trim().replace(/,/g, '');
  if (!/^-?\d+(\.0+)?$/.test(text)) return null;
  return Math.max(0, Math.min(parseInt(text, 10), SOURCE_LIMITS.stock));
}

const clean = (s: string | undefined | null, max: number): string =>
  (s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, max);

function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') && url.length <= SOURCE_LIMITS.imageUrl
    );
  } catch {
    return false;
  }
}

export type NormalizeResult =
  | { ok: true; product: SourceProduct; notes: SourceProblem[] }
  | { ok: false; problem: SourceProblem };

/**
 * Makes a product fit Sellora's rules: lengths cut to the limits, duplicate tags, option
 * values and photos dropped, a single "Default Title"-style option removed, and every variant
 * given a value for each option. Refuses what cannot be fixed (no name, no variant, a
 * variant without a price, two variants with the same options).
 */
export function normalizeSourceProduct(raw: SourceProduct): NormalizeResult {
  const name = clean(raw.name, SOURCE_LIMITS.name);
  const ref = name || `item ${raw.externalId}`;
  if (!name) return { ok: false, problem: { ref, message: 'It has no name.' } };
  const notes: SourceProblem[] = [];

  let options = raw.options
    .map((o) => ({
      name: clean(o.name, SOURCE_LIMITS.optionName),
      values: uniqueBy(
        o.values.map((v) => clean(v, SOURCE_LIMITS.optionValue)).filter(Boolean),
        (v) => v.toLowerCase(),
      ),
    }))
    .filter((o) => o.name && o.values.length);
  options = uniqueBy(options, (o) => o.name.toLowerCase());
  let variants = raw.variants.map((v) => ({
    ...v,
    optionValues: v.optionValues.map((x) => clean(x, SOURCE_LIMITS.optionValue)),
  }));
  // Shopify and others give a product without choices one option ("Title: Default Title").
  if (options.length === 1 && options[0]!.values.length === 1 && variants.length === 1) {
    options = [];
    variants = variants.map((v) => ({ ...v, optionValues: [] }));
  }
  if (options.length > SOURCE_LIMITS.options) {
    notes.push({ ref, message: `Only the first ${SOURCE_LIMITS.options} options are kept.` });
    options = options.slice(0, SOURCE_LIMITS.options);
    variants = variants.map((v) => ({
      ...v,
      optionValues: v.optionValues.slice(0, SOURCE_LIMITS.options),
    }));
  }
  for (const o of options)
    if (o.values.length > SOURCE_LIMITS.optionValues)
      return {
        ok: false,
        problem: { ref, message: `${o.name} has more than ${SOURCE_LIMITS.optionValues} values.` },
      };

  if (!variants.length) return { ok: false, problem: { ref, message: 'It has no price.' } };
  if (variants.length > SOURCE_LIMITS.variants) {
    notes.push({ ref, message: `Only the first ${SOURCE_LIMITS.variants} variants are kept.` });
    variants = variants.slice(0, SOURCE_LIMITS.variants);
  }

  // Every variant needs one known value per option; values missing from the option are added.
  for (const v of variants) {
    if (v.optionValues.length !== options.length)
      return {
        ok: false,
        problem: { ref, message: 'A variant does not have a value for every option.' },
      };
    v.optionValues.forEach((val, i) => {
      const opt = options[i]!;
      const known = opt.values.find((x) => x.toLowerCase() === val.toLowerCase());
      if (known) v.optionValues[i] = known;
      else if (val) opt.values.push(val);
    });
    if (v.optionValues.some((x) => !x))
      return { ok: false, problem: { ref, message: 'A variant has an empty option value.' } };
  }
  if (options.some((o) => o.values.length > SOURCE_LIMITS.optionValues))
    return { ok: false, problem: { ref, message: 'An option has too many values.' } };
  const combos = new Set<string>();
  for (const v of variants) {
    const key = v.optionValues.join('\u0000').toLowerCase();
    if (combos.has(key))
      return {
        ok: false,
        problem: {
          ref,
          message: v.optionValues.length
            ? `Two variants are both ${v.optionValues.join(' / ')}.`
            : 'It is listed more than once.',
        },
      };
    combos.add(key);
  }
  const externalIds = new Set<string>();
  const skus = new Set<string>();
  const cleanVariants: SourceVariant[] = [];
  for (const v of variants) {
    if (!Number.isSafeInteger(v.priceMinor) || v.priceMinor < 0)
      return { ok: false, problem: { ref, message: 'A variant has no valid price.' } };
    const sku = clean(v.sku, SOURCE_LIMITS.sku) || undefined;
    if (sku) {
      if (skus.has(sku.toLowerCase()))
        return { ok: false, problem: { ref, message: `SKU ${sku} is used by two variants.` } };
      skus.add(sku.toLowerCase());
    }
    let externalId = clean(v.externalId, 200) || v.optionValues.join(' / ') || 'default';
    while (externalIds.has(externalId)) externalId = `${externalId}+`;
    externalIds.add(externalId);
    const compare =
      v.compareAtPriceMinor !== undefined && v.compareAtPriceMinor > v.priceMinor
        ? v.compareAtPriceMinor
        : undefined;
    const barcode = clean(v.barcode, SOURCE_LIMITS.sku) || undefined;
    cleanVariants.push({
      externalId,
      optionValues: v.optionValues,
      ...(sku ? { sku } : {}),
      ...(barcode ? { barcode } : {}),
      priceMinor: v.priceMinor,
      ...(compare !== undefined ? { compareAtPriceMinor: compare } : {}),
      trackStock: v.trackStock,
      stock: v.trackStock ? Math.max(0, Math.min(Math.trunc(v.stock), SOURCE_LIMITS.stock)) : 0,
      ...(v.weightGrams !== undefined && v.weightGrams >= 0
        ? { weightGrams: Math.min(Math.round(v.weightGrams), SOURCE_LIMITS.weightGrams) }
        : {}),
    });
  }

  const images = uniqueBy(
    raw.images
      .map((i) => ({ url: i.url.trim(), alt: clean(i.alt, SOURCE_LIMITS.imageAlt) || undefined }))
      .filter((i) => {
        const ok = isHttpUrl(i.url);
        if (!ok && i.url) notes.push({ ref, message: `Skipped a photo with a bad address.` });
        return ok;
      }),
    (i) => i.url,
  );
  if (images.length > SOURCE_LIMITS.images)
    notes.push({ ref, message: `Only the first ${SOURCE_LIMITS.images} photos are kept.` });

  const tags = uniqueBy(raw.tags.map((t) => clean(t, SOURCE_LIMITS.tag)).filter(Boolean), (t) =>
    t.toLowerCase(),
  ).slice(0, SOURCE_LIMITS.tags);
  const category = clean(raw.category, SOURCE_LIMITS.category) || undefined;

  return {
    ok: true,
    notes,
    product: {
      externalId: clean(raw.externalId, 200),
      name,
      description: (raw.description ?? '')
        .normalize('NFC')
        .trim()
        .slice(0, SOURCE_LIMITS.description),
      active: raw.active,
      tags,
      ...(category ? { category } : {}),
      images: images.slice(0, SOURCE_LIMITS.images).map((i) => (i.alt ? i : { url: i.url })),
      options,
      variants: cleanVariants,
    },
  };
}

/**
 * Fingerprint of what a sync writes for a product: when it is unchanged the product is
 * skipped. Stock counts only when the source syncs stock.
 */
export function productHash(p: SourceProduct, opts: { syncStock: boolean }): string {
  const canonical = {
    n: p.name,
    d: p.description,
    a: p.active,
    t: p.tags,
    c: p.category ?? null,
    i: p.images.map((i) => [i.url, i.alt ?? '']),
    o: p.options.map((o) => [o.name, o.values]),
    v: p.variants.map((v) => [
      v.externalId,
      v.optionValues,
      v.sku ?? null,
      v.barcode ?? null,
      v.priceMinor,
      v.compareAtPriceMinor ?? null,
      v.trackStock,
      opts.syncStock ? v.stock : null,
      v.weightGrams ?? null,
    ]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url').slice(0, 32);
}
