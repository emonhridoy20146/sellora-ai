import type { SafeHttp } from '../../../infra/http/safe-http.js';
import type { SourceProblem, SourceProduct } from '../source-product.js';

export const SOURCE_KINDS = ['shopify', 'woocommerce', 'sheet', 'csv', 'website'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_LABEL: Record<SourceKind, string> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  sheet: 'Google Sheets / CSV link',
  csv: 'CSV file',
  website: 'Your website',
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
  /** Website sources (ADR 0024). */
  website?: WebsiteInput;
}

export interface WebsiteInput {
  /** The ownership token the site must still show (meta tag or DNS TXT). */
  token: string;
  importProducts: boolean;
  readPages: boolean;
  /** Page keys that held this source's products last time: read first, so each is re-checked. */
  productPages: string[];
}

/** What DNS says at `_sellora-verify.<domain>`. */
export interface VerifyRecords {
  txt: string[];
  /** DNS did not answer (as opposed to "no such record"). */
  unreachable: boolean;
}

export interface ConnectorContext {
  http: SafeHttp;
  /** SHOPIFY_API_VERSION and the like. */
  setting: (key: 'SHOPIFY_API_VERSION') => string;
  /** Website sources: the TXT records at `_sellora-verify.<domain>`. */
  verifyRecords?: (domain: string) => Promise<VerifyRecords>;
  /** Website sources: how much one crawl may read and how politely. */
  crawl?: CrawlLimits;
}

export interface CrawlLimits {
  /** Pages one crawl may read (the plan's limit, capped by CRAWL_MAX_PAGES). */
  maxPages: number;
  userAgent: string;
  /** Least time between two requests to the site; robots.txt may ask for more. */
  minDelayMs: number;
}

/** What a website check found (ADR 0024). */
export interface SiteCheck {
  /** The address that will be crawled (after the home page's redirects). */
  address: string;
  /** The home page may be crawled under robots.txt. */
  robotsAllowed: boolean;
  /** Pages listed in the site's sitemaps (first sitemap level), when it has any. */
  sitemapPages: number | null;
  /** The home page already carries a sellora-site-verification tag. */
  hasVerificationTag: boolean;
  /** Words of text on the home page. */
  homeWords: number;
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
  /** Websites. */
  site?: SiteCheck;
}

export interface SourceBatch {
  products: SourceProduct[];
  problems: SourceProblem[];
  /** Websites: pages read in this batch whose text the AI may use. */
  pages?: CrawledPage[];
  /** Websites: keys of pages read and found gone (404, moved away, noindex, disallowed). */
  gonePages?: string[];
  /** Websites: products whose page was read and no longer carries them (external ids). */
  goneProducts?: string[];
  /** Websites: products whose page moved to another address on the site (re-keyed, not re-created). */
  movedProducts?: { from: string; to: string }[];
  /** Websites: sent with the last batch. */
  crawlEnd?: CrawlEnd;
}

export interface CrawledPage {
  key: string;
  url: string;
  title: string;
  description: string;
  text: string;
  words: number;
  lang: string | null;
}

export interface CrawlEnd {
  /** Pages fetched (the plan's page budget counts these). */
  read: number;
  /** Addresses found but not read because the budget ran out. */
  notRead: number;
}

/** One kind of catalog source. Every request goes through ConnectorContext.http. */
export interface CatalogConnector {
  readonly kind: SourceKind;
  /**
   * A read may not see everything the source has (a crawl stops at its page budget), so
   * products are archived only when the batch says they are gone, never for being unseen.
   */
  readonly partialReads?: boolean;
  /** Reads a little of the source to prove the address and credentials work. */
  check(input: ConnectorInput, ctx: ConnectorContext): Promise<SourceCheck>;
  /** Every product at the source, in batches; throws SourceError when it cannot finish. */
  read(input: ConnectorInput, ctx: ConnectorContext): AsyncGenerator<SourceBatch>;
}

export type SourceErrorKind =
  | 'auth'
  | 'ownership'
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
