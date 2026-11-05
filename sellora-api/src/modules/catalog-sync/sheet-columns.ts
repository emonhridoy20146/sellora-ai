import type { CsvTable } from '../../common/files/csv.js';
import { htmlToPlainText } from '../../common/text/html-text.js';
import {
  asciiDigits,
  parseCount,
  parsePrice,
  type SourceProblem,
  type SourceProduct,
} from './source-product.js';

/**
 * Turns a sheet (a CSV table) into source products (ADR 0023). Columns are matched by their
 * header, in English or Bangla, ignoring case, spaces and punctuation. Rows with the same
 * handle (or, without a handle column, the same name) are the variants of one product.
 */

export const SHEET_FIELDS = [
  'handle',
  'name',
  'description',
  'price',
  'compareAt',
  'sku',
  'barcode',
  'stock',
  'category',
  'tags',
  'image',
  'status',
  'weight',
] as const;
export type SheetField = (typeof SHEET_FIELDS)[number];

const ALIASES: Record<SheetField, string[]> = {
  handle: [
    'handle',
    'group',
    'group id',
    'product id',
    'parent',
    'parent sku',
    'item group id',
    'url handle',
  ],
  name: [
    'name',
    'title',
    'product',
    'product name',
    'product title',
    'item',
    'item name',
    'নাম',
    'পণ্যের নাম',
    'পণ্য',
    'প্রোডাক্ট',
    'প্রোডাক্টের নাম',
  ],
  description: [
    'description',
    'details',
    'body',
    'body html',
    'product description',
    'বিবরণ',
    'বর্ণনা',
  ],
  price: [
    'price',
    'sale price',
    'selling price',
    'variant price',
    'unit price',
    'দাম',
    'মূল্য',
    'বিক্রয় মূল্য',
  ],
  compareAt: [
    'compare at price',
    'variant compare at price',
    'old price',
    'regular price',
    'mrp',
    'compare price',
    'original price',
    'আগের দাম',
    'পুরাতন দাম',
  ],
  sku: ['sku', 'variant sku', 'code', 'product code', 'item code', 'কোড'],
  barcode: ['barcode', 'variant barcode', 'ean', 'upc', 'gtin'],
  stock: [
    'stock',
    'quantity',
    'qty',
    'inventory',
    'variant inventory qty',
    'stock quantity',
    'in stock',
    'স্টক',
    'পরিমাণ',
  ],
  category: [
    'category',
    'type',
    'product type',
    'product category',
    'collection',
    'ক্যাটাগরি',
    'ক্যাটেগরি',
    'বিভাগ',
  ],
  tags: ['tags', 'tag', 'keywords', 'ট্যাগ'],
  image: [
    'image',
    'images',
    'image url',
    'image src',
    'image link',
    'photo',
    'photos',
    'picture',
    'variant image',
    'additional image link',
    'ছবি',
  ],
  status: ['status', 'active', 'published', 'visible', 'availability'],
  weight: ['weight', 'weight g', 'weight grams', 'variant grams', 'grams', 'ওজন'],
};

/** Columns that are an option by their name (a "Size" column holds each row's size). */
const NAMED_OPTIONS: Record<string, string> = {
  size: 'Size',
  সাইজ: 'Size',
  colour: 'Colour',
  color: 'Colour',
  রং: 'Colour',
  রঙ: 'Colour',
  material: 'Material',
  style: 'Style',
};

/** Lower case, no punctuation or extra spaces: "Variant Compare-At Price" → "variant compare at price". */
export function headerKey(header: string): string {
  return header
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

/** The keys a header may match: as written, and without a part in brackets ("Price (BDT)"). */
function headerKeys(header: string): string[] {
  const full = headerKey(header);
  const bare = headerKey(header.replace(/\([^)]*\)|\[[^\]]*\]/g, ' '));
  return full === bare ? [full] : [full, bare];
}

export interface SheetColumns {
  fields: Partial<Record<SheetField, number>>;
  /** Option columns: an index pair (Shopify's Option1 Name/Value) or one named column. */
  options: (
    { kind: 'pair'; nameAt: number; valueAt: number } | { kind: 'named'; name: string; at: number }
  )[];
  /** Headers that matched nothing. */
  unused: string[];
}

export function matchColumns(header: string[]): SheetColumns {
  const fields: Partial<Record<SheetField, number>> = {};
  const pairs = new Map<number, { nameAt?: number; valueAt?: number }>();
  const named: { name: string; at: number }[] = [];
  const unused: string[] = [];
  header.forEach((raw, at) => {
    const keys = headerKeys(raw);
    const key = keys[keys.length - 1]!;
    if (!key) return;
    const pair = /^option\s*(\d)\s*(name|value)$/.exec(key);
    if (pair) {
      const n = Number(pair[1]);
      const entry = pairs.get(n) ?? {};
      if (pair[2] === 'name') entry.nameAt = at;
      else entry.valueAt = at;
      pairs.set(n, entry);
      return;
    }
    const field = SHEET_FIELDS.find((f) => keys.some((k) => ALIASES[f].includes(k)));
    if (field && fields[field] === undefined) {
      fields[field] = at;
      return;
    }
    const option = keys.map((k) => NAMED_OPTIONS[k]).find(Boolean);
    if (option && !named.some((o) => o.name === option)) {
      named.push({ name: option, at });
      return;
    }
    unused.push(raw);
  });
  const options: SheetColumns['options'] = [];
  for (const [, p] of [...pairs.entries()].sort((a, b) => a[0] - b[0]))
    if (p.nameAt !== undefined && p.valueAt !== undefined)
      options.push({ kind: 'pair', nameAt: p.nameAt, valueAt: p.valueAt });
  // Named columns only when the sheet has no Option1/Option2 pairs (they would say the same).
  if (!options.length) for (const o of named) options.push({ kind: 'named', ...o });
  return { fields, options, unused };
}

const INACTIVE = new Set([
  'draft',
  'no',
  'n',
  'false',
  '0',
  'archived',
  'hidden',
  'inactive',
  'off',
  'unpublished',
  'private',
  'না',
  'বন্ধ',
]);

/** Splits a cell of several photo links (spaces, commas, semicolons, new lines, "|"). */
export function imageLinks(cell: string): string[] {
  return cell
    .split(/[\s,;|]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function splitTags(cell: string): string[] {
  return cell
    .split(/[,;|]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function weightGrams(cell: string): number | undefined {
  const text = asciiDigits(cell).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(kg|g|gm|gram|grams)?$/.exec(text);
  if (!m) return undefined;
  const value = Number(m[1]);
  return Math.round(m[2] === 'kg' ? value * 1000 : value);
}

export interface SheetResult {
  products: SourceProduct[];
  problems: SourceProblem[];
  columns: SheetColumns;
  rowsRead: number;
}

interface Group {
  key: string;
  firstLine: number;
  rows: { cells: string[]; line: number }[];
}

export function sheetProducts(table: CsvTable, currency: string): SheetResult {
  const columns = matchColumns(table.header);
  // Each problem keeps its line so the list reads in sheet order.
  const found: { line: number; problem: SourceProblem }[] = [];
  const report = (line: number, problem: SourceProblem) => found.push({ line, problem });
  const f = columns.fields;
  if (f.name === undefined && f.handle === undefined)
    return {
      products: [],
      problems: [{ ref: 'Header row', message: 'No "Name" (or "Title") column was found.' }],
      columns,
      rowsRead: 0,
    };
  if (f.price === undefined)
    return {
      products: [],
      problems: [{ ref: 'Header row', message: 'No "Price" column was found.' }],
      columns,
      rowsRead: 0,
    };
  const cell = (cells: string[], field: SheetField): string =>
    f[field] === undefined ? '' : (cells[f[field]] ?? '').trim();

  const groups = new Map<string, Group>();
  let rowsRead = 0;
  table.rows.forEach((cells, i) => {
    if (cells.every((c) => !c.trim())) return;
    rowsRead += 1;
    const line = table.lines[i] ?? i + 2;
    const handle = cell(cells, 'handle');
    const name = cell(cells, 'name');
    const key = handle
      ? `handle:${handle.toLowerCase()}`
      : name
        ? `name:${name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ')}`
        : '';
    if (!key) {
      report(line, { ref: `Row ${line}`, message: 'It has no name.', skipped: true });
      return;
    }
    const group = groups.get(key) ?? { key, firstLine: line, rows: [] };
    group.rows.push({ cells, line });
    groups.set(key, group);
  });

  const products: SourceProduct[] = [];
  for (const group of groups.values()) {
    const first = (field: SheetField) => {
      for (const r of group.rows) {
        const v = cell(r.cells, field);
        if (v) return v;
      }
      return '';
    };
    const name = first('name');
    if (!name) {
      report(group.firstLine, {
        ref: `Row ${group.firstLine}`,
        message: 'It has no name.',
        skipped: true,
      });
      continue;
    }
    const optionNames = columns.options.map((o) =>
      o.kind === 'named'
        ? o.name
        : (group.rows.map((r) => (r.cells[o.nameAt] ?? '').trim()).find(Boolean) ?? ''),
    );
    const images: { url: string }[] = [];
    const variants: SourceProduct['variants'] = [];
    let failed = false;
    for (const r of group.rows) {
      for (const url of imageLinks(cell(r.cells, 'image'))) images.push({ url });
      const priceText = cell(r.cells, 'price');
      const values = columns.options.map((o) =>
        (r.cells[o.kind === 'named' ? o.at : o.valueAt] ?? '').trim(),
      );
      // Shopify's export has rows with only another photo of the product.
      if (!priceText && values.every((v) => !v) && !cell(r.cells, 'sku')) continue;
      const price = parsePrice(priceText, currency);
      if (price === null) {
        report(r.line, {
          ref: `Row ${r.line} (${name})`,
          message: priceText ? `The price "${priceText}" is not a number.` : 'It has no price.',
          skipped: true,
        });
        failed = true;
        continue;
      }
      const compareText = cell(r.cells, 'compareAt');
      const compare = compareText ? parsePrice(compareText, currency) : null;
      const stockText = cell(r.cells, 'stock');
      const lowered = stockText.toLowerCase();
      let trackStock = false;
      let stock = 0;
      if (/^(out of stock|sold out|no|0|নেই|স্টক নেই)$/.test(lowered)) trackStock = true;
      else if (stockText && !/^(in stock|yes|available|আছে)$/.test(lowered)) {
        const n = parseCount(stockText);
        if (n === null) {
          report(r.line, {
            ref: `Row ${r.line} (${name})`,
            message: `The stock "${stockText}" is not a whole number.`,
            skipped: true,
          });
          failed = true;
          continue;
        }
        trackStock = true;
        stock = n;
      }
      const sku = cell(r.cells, 'sku');
      const weight = weightGrams(cell(r.cells, 'weight'));
      // Option columns that are empty for every row of this product are not options of it.
      variants.push({
        externalId: sku || values.filter(Boolean).join(' / ') || 'default',
        optionValues: values,
        ...(sku ? { sku } : {}),
        ...(cell(r.cells, 'barcode') ? { barcode: cell(r.cells, 'barcode') } : {}),
        priceMinor: price,
        ...(compare !== null ? { compareAtPriceMinor: compare } : {}),
        trackStock,
        stock,
        ...(weight !== undefined ? { weightGrams: weight } : {}),
      });
    }
    if (failed && !variants.length) continue;
    if (!variants.length) {
      report(group.firstLine, {
        ref: `Row ${group.firstLine} (${name})`,
        message: 'It has no price.',
        skipped: true,
      });
      continue;
    }
    // Keep only options that some variant of this product uses.
    const used = optionNames.map((_, i) => variants.some((v) => v.optionValues[i]));
    const options = optionNames
      .map((n, i) => ({
        name: n || `Option ${i + 1}`,
        values: [...new Set(variants.map((v) => v.optionValues[i]!).filter(Boolean))],
      }))
      .filter((_, i) => used[i]);
    for (const v of variants) v.optionValues = v.optionValues.filter((_, i) => used[i]);
    const statusText = first('status').toLowerCase();
    const description = first('description');
    products.push({
      externalId: group.key,
      name,
      description: /<[a-z][^>]*>/i.test(description) ? htmlToPlainText(description) : description,
      active: !INACTIVE.has(statusText),
      tags: splitTags(first('tags')),
      ...(first('category') ? { category: first('category') } : {}),
      images,
      options,
      variants,
    });
  }
  const problems = found.sort((a, b) => a.line - b.line).map((x) => x.problem);
  return { products, problems, columns, rowsRead };
}
