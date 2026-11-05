import type { SafeHttp } from '../../../infra/http/safe-http.js';
import type { SourceProblem, SourceProduct } from '../source-product.js';

export const SOURCE_KINDS = ['shopify', 'woocommerce', 'sheet', 'csv'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_LABEL: Record<SourceKind, string> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  sheet: 'Google Sheets / CSV link',
  csv: 'CSV file',
};

/** What the merchant gave us for one source. Credentials are decrypted only for a call. */
export interface ConnectorInput {
  /** Shopify and WooCommerce: the shop's base address. Sheet: the CSV link. */
  url?: string;
  credentials?: Record<string, string>;
  /** CSV upload: the file's text. */
  csv?: string;
  /** The business's currency: prices are read in it. */
  currency: string;
}

export interface ConnectorContext {
  http: SafeHttp;
  /** SHOPIFY_API_VERSION and the like. */
  setting: (key: 'SHOPIFY_API_VERSION') => string;
}

export interface SourceCheck {
  /** The shop's or sheet's own name, when it has one. */
  title: string | null;
  /** The currency the source sells in, when it says. */
  currency: string | null;
  /** Products at the source, when it says. */
  productCount: number | null;
  /** Up to 5 products as they would be imported. */
  sample: SourceProduct[];
  problems: SourceProblem[];
  /** Sheets: which column was matched to what. */
  columns?: { field: string; header: string }[];
  unusedColumns?: string[];
}

export interface SourceBatch {
  products: SourceProduct[];
  problems: SourceProblem[];
}

/** One kind of catalog source. Every request goes through ConnectorContext.http. */
export interface CatalogConnector {
  readonly kind: SourceKind;
  /** Reads a little of the source to prove the address and credentials work. */
  check(input: ConnectorInput, ctx: ConnectorContext): Promise<SourceCheck>;
  /** Every product at the source, in batches; throws SourceError when it cannot finish. */
  read(input: ConnectorInput, ctx: ConnectorContext): AsyncGenerator<SourceBatch>;
}

export type SourceErrorKind =
  | 'auth'
  | 'not_found'
  | 'bad_input'
  | 'rate_limited'
  | 'unavailable'
  | 'bad_response'
  | 'too_large';

/**
 * Why a source could not be read, in words for the merchant. `retryable` errors are tried
 * again at the next sync; the others need the merchant to change something.
 */
export class SourceError extends Error {
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SourceError';
  }

  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}
