import type { Writable } from 'node:stream';
import type { mongo } from 'mongoose';
import { currencyInfo } from '../../common/money/money.js';
import { ZipWriter } from '../../common/files/zip.js';

/**
 * "Download your data" (ADR 0021): a ZIP a merchant can open without Sellora. One JSON file
 * per collection with all of the business's documents, CSV files for spreadsheets, and a
 * README. Only documents with this business's orgId, and never secrets.
 */

/** The business's collections in the download, and what to leave out of each. */
export const EXPORT_COLLECTIONS: { name: string; file?: string; omit?: string[] }[] = [
  { name: 'products' },
  { name: 'categories' },
  { name: 'stockmovements', file: 'stock_movements' },
  { name: 'customers' },
  { name: 'orders' },
  { name: 'parcels' },
  { name: 'conversations' },
  { name: 'messages' },
  { name: 'contacts' },
  { name: 'channels' },
  { name: 'stores' },
  { name: 'store_domains' },
  { name: 'landing_pages' },
  { name: 'landing_page_versions' },
  { name: 'landing_page_stats' },
  { name: 'landing_ab_tests' },
  { name: 'landing_templates' },
  { name: 'coupons' },
  { name: 'coupon_uses' },
  { name: 'keyword_research' },
  { name: 'keyword_lists' },
  { name: 'seo_google' },
  { name: 'search_console_days' },
  { name: 'search_console_rows' },
  { name: 'seo_bulk_runs' },
  { name: 'content_drafts' },
  { name: 'shopsettings', file: 'shop_settings' },
  { name: 'ai_agent_settings' },
  { name: 'carts' },
  { name: 'cartsettings', file: 'cart_settings' },
  { name: 'campaigns' },
  { name: 'campaignrecipients', file: 'campaign_recipients' },
  { name: 'automationsettings', file: 'automation_settings' },
  { name: 'automationsends', file: 'automation_sends' },
  { name: 'marketinglinks', file: 'marketing_links' },
  { name: 'smsmessages', file: 'sms_messages', omit: ['costMinor', 'held'] },
  { name: 'smslinks', file: 'sms_links' },
  { name: 'smsoptouts', file: 'sms_opt_outs' },
  { name: 'smssettings', file: 'sms_settings' },
  { name: 'fraudsettings', file: 'fraud_settings' },
  { name: 'catalog_sources', omit: ['lease'] },
  { name: 'catalog_sync_runs', omit: ['csv'] },
  { name: 'website_pages' },
  { name: 'storedfiles', file: 'files' },
  { name: 'subscriptions' },
  { name: 'invoices' },
  { name: 'payments' },
  { name: 'wallets' },
  { name: 'wallet_ledger' },
  { name: 'audit_events', file: 'activity_log', omit: ['hash', 'prevHash', 'seq', 'scope'] },
];

/** Keys never written anywhere in the download: encrypted secrets, hashes, tokens. */
const SECRET_KEY =
  /(Enc|Hash)$|^(token|password|passwordHash|secret|idempotencyKey|searchText|__v)$/;

type Bsonish = { _bsontype?: string; toHexString?: () => string; toString(): string };

/** A BSON value as plain JSON: ids as hex, dates as ISO text, decimals as text. */
export function plain(value: unknown, omit: ReadonlySet<string> = new Set()): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => plain(v));
  if (typeof value === 'object') {
    const t = (value as Bsonish)._bsontype;
    if (t === 'ObjectId') return (value as Bsonish).toHexString!();
    if (t === 'Decimal128' || t === 'Long') return (value as Bsonish).toString();
    if (t === 'Double' || t === 'Int32') return Number((value as Bsonish).toString());
    if (t === 'Binary')
      return Buffer.from((value as { buffer: Uint8Array }).buffer).toString('base64');
    if (t) return (value as Bsonish).toString();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) || omit.has(k)) continue;
      out[k] = plain(v);
    }
    return out;
  }
  return value;
}

/** Any value as text: BSON values by their own text, other objects as JSON. */
export function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const p = plain(v);
    return typeof p === 'string' ? p : JSON.stringify(p);
  }
  return '';
}

/** One CSV cell. Text a spreadsheet would run as a formula gets a leading apostrophe. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = text(value);
  // A plain number (such as -120 or -1250.50) cannot be a formula, so it stays a number.
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

/** Minor units as a decimal amount in the currency ("1250.50"). */
export function money(minor: unknown, currency: string): string {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return '';
  let digits = 2;
  try {
    digits = currencyInfo(currency).minorUnits;
  } catch {
    // An unknown currency is shown with two decimals.
  }
  if (digits === 0) return String(minor);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  const div = 10 ** digits;
  return `${sign}${Math.floor(abs / div)}.${String(abs % div).padStart(digits, '0')}`;
}

type Doc = Record<string, unknown>;
const str = text;
const list = (v: unknown) => (Array.isArray(v) ? v.map(text).join('; ') : '');

function address(a: unknown): string {
  if (!a || typeof a !== 'object') return '';
  const x = a as Record<string, unknown>;
  return [x.line1, x.area, x.city, x.district].filter(Boolean).map(text).join(', ');
}

async function* jsonArray(
  cursor: AsyncIterable<Doc>,
  omit: ReadonlySet<string>,
  counted: () => void,
) {
  let first = true;
  yield '[';
  for await (const doc of cursor) {
    counted();
    yield `${first ? '\n' : ',\n'}${JSON.stringify(plain(doc, omit))}`;
    first = false;
  }
  yield first ? ']\n' : '\n]\n';
}

const README = (p: { business: string; at: Date; counts: Record<string, number> }) =>
  `Your data from Sellora AI
=========================

Business: ${p.business}
Made: ${p.at.toISOString()}

products.csv, customers.csv and orders.csv open in Excel, Google Sheets or LibreOffice.
Amounts are in your currency (for example 1250.00). products.csv has one row per variant.

The data folder has everything, one JSON file per kind of record, with the ids that link
them (for example an order's customerId is a customer's _id). Amounts in the JSON files are
in the smallest unit of the currency (poisha for taka: 125000 is 1250.00).

Not included: passwords, connection keys and other secrets, product photos and other files
(data/files.json lists them with their addresses).

Records in this download:
${Object.entries(p.counts)
  .map(([k, n]) => `  ${k.padEnd(28)} ${n}`)
  .join('\n')}
`;

/**
 * Writes the business's download to `out`. Reads with the driver, every query by `orgId`.
 * Returns the ZIP's size and the records per file.
 */
export async function writeExport(
  db: mongo.Db,
  orgId: mongo.ObjectId,
  out: Writable,
  p: { business: string; currency: string; at?: Date },
): Promise<{ size: number; counts: Record<string, number> }> {
  const at = p.at ?? new Date();
  const zip = new ZipWriter(out, at);
  const counts: Record<string, number> = {};
  const cursor = (name: string, sort: Record<string, 1 | -1> = { _id: 1 }) =>
    db.collection(name).find({ orgId }).sort(sort) as unknown as AsyncIterable<Doc>;
  const cur = p.currency;

  async function* products() {
    yield csvRow([
      'product_id',
      'name',
      'status',
      'variant',
      'sku',
      'price',
      'compare_at_price',
      'cost',
      'stock',
      'tags',
      'created_at',
    ]);
    for await (const d of cursor('products')) {
      const variants = (Array.isArray(d.variants) ? d.variants : [{}]) as Doc[];
      const c = str(d.currency) || cur;
      for (const v of variants)
        yield csvRow([
          str(d._id),
          d.name,
          d.status,
          v.title,
          v.sku,
          money(v.priceMinor, c),
          money(v.compareAtPriceMinor, c),
          money(v.costMinor, c),
          v.stock,
          list(d.tags),
          d.createdAt,
        ]);
    }
  }
  async function* customers() {
    yield csvRow([
      'customer_id',
      'name',
      'phone',
      'email',
      'address',
      'orders',
      'delivered',
      'cancelled',
      'returned',
      'spent',
      'last_order_at',
      'tags',
      'source',
      'blocked',
      'created_at',
    ]);
    for await (const d of cursor('customers')) {
      const s = (d.stats ?? {}) as Doc;
      const first = Array.isArray(d.addresses) ? (d.addresses as unknown[])[0] : undefined;
      yield csvRow([
        str(d._id),
        d.name,
        d.phone,
        d.email,
        address(first),
        s.orders,
        s.delivered,
        s.cancelled,
        s.returned,
        money(s.spentMinor, cur),
        s.lastOrderAt,
        list(d.tags),
        d.source,
        d.blocked ? 'yes' : 'no',
        d.createdAt,
      ]);
    }
  }
  async function* orders() {
    yield csvRow([
      'order_number',
      'placed_at',
      'status',
      'source',
      'customer',
      'phone',
      'address',
      'items',
      'subtotal',
      'discount',
      'delivery',
      'total',
      'currency',
      'payment_method',
      'payment_status',
      'paid',
    ]);
    for await (const d of cursor('orders', { seq: 1 })) {
      const c = str(d.currency) || cur;
      const customer = (d.customer ?? {}) as Doc;
      const payment = (d.payment ?? {}) as Doc;
      const items = (Array.isArray(d.items) ? d.items : []) as Doc[];
      const itemText = items
        .map(
          (i) =>
            `${str(i.name)}${i.variantTitle && i.variantTitle !== 'Default' ? ` (${str(i.variantTitle)})` : ''} x${str(i.quantity)}`,
        )
        .join('; ');
      yield csvRow([
        d.number,
        d.createdAt,
        d.status,
        d.source,
        customer.name,
        customer.phone,
        address(d.shippingAddress),
        itemText,
        money(d.subtotalMinor, c),
        money(d.discountMinor, c),
        money(d.deliveryChargeMinor, c),
        money(d.totalMinor, c),
        c,
        payment.method,
        payment.status,
        money(payment.paidMinor, c),
      ]);
    }
  }

  await zip.add('products.csv', products());
  await zip.add('customers.csv', customers());
  await zip.add('orders.csv', orders());
  const org = await db.collection('organizations').findOne({ _id: orgId });
  await zip.add('data/business.json', `${JSON.stringify(plain(org), null, 2)}\n`);
  for (const c of EXPORT_COLLECTIONS) {
    const file = c.file ?? c.name;
    counts[file] = 0;
    await zip.add(
      `data/${file}.json`,
      jsonArray(cursor(c.name), new Set(c.omit ?? []), () => {
        counts[file] = (counts[file] ?? 0) + 1;
      }),
    );
  }
  await zip.add('README.txt', README({ business: p.business, at, counts }));
  const { size } = await zip.finish();
  return { size, counts };
}
