import { CsvError, parseCsv } from '../../../common/files/csv.js';
import { SHEET_FIELDS, sheetProducts, type SheetResult } from '../sheet-columns.js';
import {
  SourceError,
  type CatalogConnector,
  type ConnectorContext,
  type ConnectorInput,
  type SourceBatch,
  type SourceCheck,
} from './connector.js';
import { call } from './http.js';

/**
 * A Google Sheet shared as "anyone with the link can view", any other CSV link, or an
 * uploaded CSV file (ADR 0023). The whole file is read and turned into products by
 * `sheetProducts`; a link is read again at every sync.
 */

const MB = 1024 * 1024;
export const SHEET_MAX_BYTES = 5 * MB;
/** Kept under the API's 1 MB JSON body limit, with room for escaping. */
export const CSV_UPLOAD_MAX_BYTES = 700 * 1024;
export const SHEET_MAX_ROWS = 20_000;
const BATCH = 50;

/**
 * A Google Sheets address as its CSV export link (the tab in `gid`, else the first); other
 * links unchanged.
 */
export function normalizeSheetUrl(input: string): string {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SourceError('bad_input', 'Paste the full link to the sheet, starting with https://.');
  }
  if (url.hostname === 'docs.google.com') {
    const published = /^\/spreadsheets\/d\/e\/([\w-]+)\//.exec(url.pathname);
    if (published) {
      const gid = url.searchParams.get('gid');
      return `https://docs.google.com/spreadsheets/d/e/${published[1]}/pub?${gid ? `gid=${gid}&` : ''}single=true&output=csv`;
    }
    const doc = /^\/spreadsheets\/d\/([\w-]+)/.exec(url.pathname);
    if (!doc) throw new SourceError('bad_input', 'This is not a link to a Google Sheet.');
    const gid = /gid=(\d+)/.exec(url.hash)?.[1] ?? url.searchParams.get('gid');
    return `https://docs.google.com/spreadsheets/d/${doc[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
  }
  return url.toString();
}

function parse(text: string, currency: string): SheetResult {
  try {
    return sheetProducts(parseCsv(text, { maxRows: SHEET_MAX_ROWS }), currency);
  } catch (err) {
    if (err instanceof CsvError) throw new SourceError('bad_input', err.message);
    throw err;
  }
}

function checkOf(result: SheetResult, title: string | null, header: string[]): SourceCheck {
  const columns = Object.entries(result.columns.fields).map(([field, at]) => ({
    field,
    header: header[at] ?? '',
  }));
  for (const o of result.columns.options)
    columns.push({
      field: 'option',
      header:
        o.kind === 'named'
          ? (header[o.at] ?? o.name)
          : `${header[o.nameAt]} / ${header[o.valueAt]}`,
    });
  columns.sort(
    (a, b) => SHEET_FIELDS.indexOf(a.field as never) - SHEET_FIELDS.indexOf(b.field as never),
  );
  return {
    title,
    currency: null,
    productCount: result.products.length,
    sample: result.products.slice(0, 5),
    problems: result.problems.slice(0, 50),
    columns,
    unusedColumns: result.columns.unused,
  };
}

function filenameOf(disposition: string | undefined): string | null {
  if (!disposition) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  const raw = star ? decodeURIComponent(star[1]!) : plain?.[1];
  return raw ? raw.replace(/\.csv$/i, '').trim() || null : null;
}

async function download(input: ConnectorInput, ctx: ConnectorContext) {
  if (!input.url) throw new SourceError('bad_input', 'The sheet link is missing.');
  const res = await call(
    ctx,
    input.url,
    { headers: { accept: 'text/csv, text/plain;q=0.9, */*;q=0.1' }, maxBytes: SHEET_MAX_BYTES },
    'The sheet',
  );
  const type = (res.headers['content-type'] ?? '').toLowerCase();
  const text = res.text();
  if (type.includes('text/html') || /^\s*<(!doctype|html)/i.test(text))
    throw new SourceError(
      'auth',
      'The link opens a web page, not the sheet’s data. In Google Sheets choose Share › "Anyone with the link" › Viewer, then paste the link again.',
    );
  return { text, title: filenameOf(res.headers['content-disposition']) };
}

function batches(result: SheetResult): SourceBatch[] {
  if (!result.products.length) return [{ products: [], problems: result.problems }];
  const out: SourceBatch[] = [];
  for (let i = 0; i < result.products.length; i += BATCH)
    out.push({
      products: result.products.slice(i, i + BATCH),
      problems: i === 0 ? result.problems : [],
    });
  return out;
}

export class SheetConnector implements CatalogConnector {
  readonly kind = 'sheet' as const;

  async check(input: ConnectorInput, ctx: ConnectorContext): Promise<SourceCheck> {
    const { text, title } = await download(input, ctx);
    const result = parse(text, input.currency);
    return checkOf(result, title, parseCsv(text, { maxRows: SHEET_MAX_ROWS }).header);
  }

  async *read(input: ConnectorInput, ctx: ConnectorContext): AsyncGenerator<SourceBatch> {
    const { text } = await download(input, ctx);
    yield* batches(parse(text, input.currency));
  }
}

export class CsvConnector implements CatalogConnector {
  readonly kind = 'csv' as const;

  private text(input: ConnectorInput): string {
    if (input.csv === undefined) throw new SourceError('bad_input', 'Upload the CSV file again.');
    return input.csv;
  }

  check(input: ConnectorInput): Promise<SourceCheck> {
    const text = this.text(input);
    const result = parse(text, input.currency);
    return Promise.resolve(
      checkOf(result, null, parseCsv(text, { maxRows: SHEET_MAX_ROWS }).header),
    );
  }

  async *read(input: ConnectorInput): AsyncGenerator<SourceBatch> {
    const text = await Promise.resolve(this.text(input));
    yield* batches(parse(text, input.currency));
  }
}
