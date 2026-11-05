import { setTimeout as sleep } from 'node:timers/promises';
import { SafeHttpError, type SafeResponse } from '../../../infra/http/safe-http.js';
import type { SourceProblem } from '../source-product.js';
import { countWords, parseHtmlPage, type HtmlPage } from '../website/html-page.js';
import { checkOwnership } from '../website/ownership.js';
import { pageProducts } from '../website/product-data.js';
import {
  ALLOW_ALL,
  isAllowed,
  parseRobots,
  ROBOTS_MAX_BYTES,
  type Robots,
} from '../website/robots.js';
import { parseSitemap, sitemapText, SITEMAP_MAX_BYTES } from '../website/sitemap.js';
import {
  crawlableUrl,
  normalizeSiteUrl,
  pageKey,
  registrableDomain,
  sameSite,
} from '../website/site-url.js';
import {
  SourceError,
  type CatalogConnector,
  type ConnectorContext,
  type ConnectorInput,
  type CrawledPage,
  type CrawlLimits,
  type SourceBatch,
  type SourceCheck,
} from './connector.js';
import { fromHttpError } from './http.js';

/**
 * The merchant's own website (ADR 0024): robots.txt, the home page (which must still prove
 * ownership), pages that held products, sitemap entries, then links; products from
 * schema.org data and page text for the AI. Every request goes through SafeHttp.
 */

const MB = 1024 * 1024;
const PAGE_MAX_BYTES = 2 * MB;
/** Pages per batch handed to the runner (products written, lease renewed). */
const BATCH_PAGES = 10;
const MAX_SITEMAP_FILES = 20;
const MAX_SITEMAP_URLS = 50_000;
const MAX_CRAWL_DELAY_MS = 5_000;
const MAX_RETRY_WAIT_MS = 10_000;
const CONCURRENCY = 2;
/** Pages with less text than this are not kept for the AI. */
export const MIN_PAGE_WORDS = 20;
/** A home page with less text than this but several scripts is built in the browser. */
const JS_SITE_WORDS = 30;
const JS_SITE_SCRIPTS = 3;
/** Problems a crawl reports about pages that could not be read. */
const MAX_PAGE_PROBLEMS = 20;

export const WEBSITE = 'Your website';

type Fetched =
  | { kind: 'html'; url: URL; page: HtmlPage }
  | { kind: 'gone'; status: number }
  | { kind: 'elsewhere'; to: string }
  | { kind: 'not_html' }
  | { kind: 'error'; message: string };

/** Requests to one site, at least `delay` apart. */
class SiteClient {
  private lastStart = 0;
  private delay: number;

  constructor(
    readonly site: URL,
    private readonly ctx: ConnectorContext,
    private readonly limits: CrawlLimits,
  ) {
    this.delay = limits.minDelayMs;
  }

  slowDown(robots: Robots) {
    if (robots.crawlDelay !== null)
      this.delay = Math.max(this.delay, Math.min(robots.crawlDelay * 1000, MAX_CRAWL_DELAY_MS));
  }

  private async pace(): Promise<void> {
    const wait = this.lastStart + this.delay - Date.now();
    this.lastStart = Date.now() + Math.max(0, wait);
    if (wait > 0) await sleep(wait);
  }

  async get(url: string, maxBytes: number, accept: string): Promise<SafeResponse> {
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      const res = await this.ctx.http.request(url, {
        maxBytes,
        headers: {
          accept,
          'accept-language': 'bn,en;q=0.8',
          'user-agent': this.limits.userAgent,
        },
      });
      if ((res.status === 429 || res.status === 503) && attempt === 0) {
        const after = Number(res.headers['retry-after']);
        await sleep(Math.min(Number.isFinite(after) ? after * 1000 : 2000, MAX_RETRY_WAIT_MS));
        this.delay = Math.min(Math.max(this.delay * 2, 500), MAX_CRAWL_DELAY_MS);
        continue;
      }
      return res;
    }
  }

  /** robots.txt: rules, or "allow all" when there is none; throws when it cannot be read. */
  async robots(): Promise<Robots> {
    let res: SafeResponse;
    try {
      res = await this.get(
        new URL('/robots.txt', this.site).toString(),
        ROBOTS_MAX_BYTES,
        'text/plain',
      );
    } catch (err) {
      if (err instanceof SafeHttpError && err.reason === 'too_large')
        throw new SourceError('bad_response', 'The site’s robots.txt is too large to read.');
      throw fromHttpError(err, 'The site’s robots.txt');
    }
    if (res.status >= 200 && res.status < 300) return parseRobots(res.text(), 'SelloraBot');
    // RFC 9309: a missing file allows everything; a server error means "do not crawl now".
    if (res.status >= 400 && res.status < 500) return ALLOW_ALL;
    throw new SourceError(
      'unavailable',
      `The site’s robots.txt could not be read (HTTP ${res.status}), so nothing was crawled. Sellora will try again.`,
    );
  }

  async page(url: URL): Promise<Fetched> {
    let res: SafeResponse;
    try {
      res = await this.get(
        url.toString(),
        PAGE_MAX_BYTES,
        'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      );
    } catch (err) {
      return { kind: 'error', message: fromHttpError(err, 'The page').message };
    }
    if (res.status === 404 || res.status === 410) return { kind: 'gone', status: res.status };
    if (res.status < 200 || res.status >= 300)
      return { kind: 'error', message: `The page answered HTTP ${res.status}.` };
    const final = new URL(res.url);
    if (!sameSite(final.hostname, this.site.hostname)) return { kind: 'elsewhere', to: final.host };
    const type = (res.headers['content-type'] ?? '').toLowerCase();
    if (type && !type.includes('html')) return { kind: 'not_html' };
    const canon = crawlableUrl(final.toString(), final.toString(), this.site) ?? final;
    return {
      kind: 'html',
      url: canon,
      page: parseHtmlPage(res.text(), res.headers['x-robots-tag']),
    };
  }

  /** The page addresses in the site's sitemaps, newest first. */
  async sitemapUrls(robots: Robots, maxUrls: number): Promise<{ urls: URL[]; files: number }> {
    const queue = robots.sitemaps.length
      ? robots.sitemaps
      : [
          new URL('/sitemap.xml', this.site).toString(),
          new URL('/sitemap_index.xml', this.site).toString(),
        ];
    const seenFiles = new Set<string>();
    const found = new Map<string, { url: URL; lastmod: number }>();
    let files = 0;
    while (queue.length && files < MAX_SITEMAP_FILES && found.size < maxUrls) {
      const next = queue.shift()!;
      if (seenFiles.has(next)) continue;
      seenFiles.add(next);
      let res: SafeResponse;
      try {
        res = await this.get(next, SITEMAP_MAX_BYTES, 'application/xml,text/xml;q=0.9,*/*;q=0.1');
      } catch {
        continue;
      }
      if (res.status < 200 || res.status >= 300) continue;
      let parsed;
      try {
        parsed = parseSitemap(sitemapText(res.bytes));
      } catch {
        continue;
      }
      if (!parsed) continue;
      files += 1;
      for (const e of parsed.entries) {
        if (parsed.kind === 'index') {
          queue.push(e.loc);
          continue;
        }
        const u = crawlableUrl(e.loc, this.site.toString(), this.site);
        if (!u) continue;
        const key = pageKey(u);
        if (!found.has(key)) found.set(key, { url: u, lastmod: e.lastmod ?? 0 });
        if (found.size >= maxUrls) break;
      }
    }
    return {
      urls: [...found.values()].sort((a, b) => b.lastmod - a.lastmod).map((f) => f.url),
      files,
    };
  }
}

function limitsOf(ctx: ConnectorContext): CrawlLimits {
  if (!ctx.crawl) throw new Error('Website sources need crawl limits in the connector context');
  return ctx.crawl;
}

function jsSiteProblem(home: HtmlPage): SourceProblem | null {
  return home.words < JS_SITE_WORDS && home.scripts >= JS_SITE_SCRIPTS
    ? {
        ref: 'Home page',
        message:
          'This site seems to build its pages with JavaScript. Sellora reads pages as the server sends them, so it may find little text or products.',
      }
    : null;
}

/** Tiered frontier: pages that held products, then sitemap entries, then links found. */
class Frontier {
  private readonly tiers: URL[][] = [[], [], []];
  readonly seen = new Set<string>();

  add(u: URL, tier: 0 | 1 | 2): void {
    const key = pageKey(u);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.tiers[tier]!.push(u);
  }

  next(): URL | undefined {
    for (const t of this.tiers) if (t.length) return t.shift();
    return undefined;
  }

  get size(): number {
    return this.tiers.reduce((n, t) => n + t.length, 0);
  }
}

export class WebsiteConnector implements CatalogConnector {
  readonly kind = 'website' as const;
  readonly partialReads = true;

  /** robots.txt, the home page and the sitemap size: nothing beyond the home page is read. */
  async check(input: ConnectorInput, ctx: ConnectorContext): Promise<SourceCheck> {
    const limits = limitsOf(ctx);
    let site = new URL(normalizeSiteUrl(input.url!));
    let client = new SiteClient(site, ctx, limits);
    const problems: SourceProblem[] = [];
    let read = await this.home(client);
    if (read.kind === 'elsewhere') {
      const to = new URL(`${site.protocol}//${read.to}/`);
      if (registrableDomain(to.hostname) !== registrableDomain(site.hostname))
        throw new SourceError(
          'bad_input',
          `This site sends visitors to ${read.to}. Add that address instead.`,
        );
      site = new URL(normalizeSiteUrl(to.toString()));
      client = new SiteClient(site, ctx, limits);
      read = await this.home(client);
    }
    if (read.kind !== 'html')
      throw new SourceError(
        read.kind === 'gone' ? 'not_found' : 'unavailable',
        read.kind === 'error'
          ? `The home page could not be read: ${read.message}`
          : 'The home page could not be read.',
      );
    let robots: Robots = ALLOW_ALL;
    let robotsAllowed = true;
    try {
      robots = await client.robots();
      robotsAllowed = isAllowed(robots, '/');
      if (!robotsAllowed)
        problems.push({
          ref: 'robots.txt',
          message:
            'The site’s robots.txt does not let SelloraBot read the home page. Allow it, or nothing can be crawled.',
        });
    } catch (err) {
      problems.push({ ref: 'robots.txt', message: (err as Error).message });
    }
    const map = await client.sitemapUrls(robots, MAX_SITEMAP_URLS);
    const js = jsSiteProblem(read.page);
    if (js) problems.push(js);
    return {
      title: read.page.title || site.hostname,
      currency: null,
      productCount: null,
      sample: [],
      problems,
      site: {
        address: site.toString(),
        robotsAllowed,
        sitemapPages: map.files ? map.urls.length : null,
        hasVerificationTag: read.page.verification.length > 0,
        homeWords: read.page.words,
      },
    };
  }

  /** The home page, following its redirects. */
  private async home(client: SiteClient): Promise<Fetched> {
    return client.page(new URL(client.site.toString()));
  }

  async *read(input: ConnectorInput, ctx: ConnectorContext): AsyncGenerator<SourceBatch> {
    const limits = limitsOf(ctx);
    const opts = input.website;
    if (!opts) throw new Error('Website sources need their website settings');
    const site = new URL(normalizeSiteUrl(input.url!));
    const client = new SiteClient(site, ctx, limits);

    const robots = await client.robots();
    client.slowDown(robots);
    if (!isAllowed(robots, '/'))
      throw new SourceError(
        'bad_input',
        'The site’s robots.txt does not let SelloraBot read the home page, so nothing was crawled.',
      );

    // The home page first: it must still prove ownership.
    const home = await client.page(new URL(site.toString()));
    const ownership = await checkOwnership({
      host: site.hostname,
      token: opts.token,
      home: home.kind === 'html' ? home.page : null,
      ...(ctx.verifyRecords ? { lookup: ctx.verifyRecords } : {}),
    });
    if (!ownership.ok)
      throw new SourceError(ownership.definite ? 'ownership' : 'unavailable', ownership.message);
    if (home.kind !== 'html')
      throw new SourceError(
        'unavailable',
        'The home page could not be read. Sellora will try again.',
      );

    const frontier = new Frontier();
    const known = new Set(opts.productPages);
    const productAt = new Map<string, string>(); // SKU → page key (one product, two addresses)
    const pending: SourceBatch = {
      products: [],
      problems: [],
      pages: [],
      gonePages: [],
      goneProducts: [],
    };
    const moved: { from: string; to: string }[] = [];
    let pageProblems = 0;
    let read = 1;
    let batchPages = 0;
    const doneKeys = new Set<string>();

    const notePage = (ref: string, message: string) => {
      if (pageProblems++ < MAX_PAGE_PROBLEMS) pending.problems.push({ ref, message });
    };
    const gone = (key: string) => {
      pending.gonePages!.push(key);
      if (known.has(key)) pending.goneProducts!.push(key);
    };

    const handle = (requested: URL, fetched: Fetched) => {
      const requestedKey = pageKey(requested);
      if (fetched.kind === 'gone' || fetched.kind === 'elsewhere') return gone(requestedKey);
      if (fetched.kind === 'not_html') return gone(requestedKey);
      if (fetched.kind === 'error')
        return notePage(requested.pathname + requested.search, fetched.message);
      const { page } = fetched;
      // The address the page calls its own, when it is a page of this site.
      const canonical = page.canonical
        ? crawlableUrl(page.canonical, page.base ?? fetched.url.toString(), site)
        : null;
      const at = canonical ?? fetched.url;
      const key = pageKey(at);
      if (key !== requestedKey) {
        if (known.has(requestedKey)) moved.push({ from: requestedKey, to: key });
        if (doneKeys.has(key)) return; // already read under its own address
      }
      if (doneKeys.has(key)) return;
      doneKeys.add(key);
      frontier.seen.add(key);
      if (!isAllowed(robots, key)) return gone(key);
      if (!page.nofollow)
        for (const href of page.links) {
          const u = crawlableUrl(href, page.base ?? fetched.url.toString(), site);
          if (u && isAllowed(robots, pageKey(u))) frontier.add(u, 2);
        }
      if (page.noindex) return gone(key);
      if (opts.readPages && page.words >= MIN_PAGE_WORDS) {
        const crawled: CrawledPage = {
          key,
          url: at.toString(),
          title: page.title || at.pathname,
          description: page.description,
          text: page.text,
          words: countWords(page.text),
          lang: page.lang,
        };
        pending.pages!.push(crawled);
      }
      if (!opts.importProducts) return;
      const found = pageProducts(page, {
        pageUrl: at.toString(),
        externalId: key,
        currency: input.currency,
      });
      for (const p of found.problems) pending.problems.push(p);
      if (!found.hasProductData) {
        if (known.has(key)) pending.goneProducts!.push(key);
        return;
      }
      if (!found.product) return;
      const skus = found.product.variants.flatMap((v) => (v.sku ? [v.sku.toLowerCase()] : []));
      const twin =
        skus.length && skus.every((s) => productAt.has(s)) ? productAt.get(skus[0]!) : undefined;
      if (twin && twin !== key) {
        pending.problems.push({
          ref: found.product.name,
          message: `It is also at ${twin}; only that address was used.`,
        });
        return;
      }
      for (const s of skus) productAt.set(s, key);
      pending.products.push(found.product);
    };

    const flush = (): SourceBatch => {
      const batch: SourceBatch = {
        products: pending.products.splice(0),
        problems: pending.problems.splice(0),
        pages: pending.pages!.splice(0),
        gonePages: pending.gonePages!.splice(0),
        goneProducts: pending.goneProducts!.splice(0),
      };
      if (moved.length) batch.movedProducts = moved.splice(0);
      return batch;
    };

    handle(new URL(site.toString()), home);
    const js = jsSiteProblem(home.page);
    if (js) pending.problems.push(js);

    // Pages that held products are re-read first; ones robots.txt now refuses are gone.
    for (const key of opts.productPages) {
      const u = crawlableUrl(key, site.toString(), site);
      if (!u) continue;
      if (!isAllowed(robots, pageKey(u))) {
        frontier.seen.add(pageKey(u));
        gone(pageKey(u));
      } else frontier.add(u, 0);
    }
    const map = await client.sitemapUrls(robots, Math.max(limits.maxPages * 2, 100));
    for (const u of map.urls) if (isAllowed(robots, pageKey(u))) frontier.add(u, 1);

    while (read < limits.maxPages && frontier.size) {
      const round: URL[] = [];
      while (round.length < CONCURRENCY && read + round.length < limits.maxPages) {
        const u = frontier.next();
        if (!u) break;
        round.push(u);
      }
      if (!round.length) break;
      const results = await Promise.all(round.map((u) => client.page(u)));
      read += round.length;
      batchPages += round.length;
      round.forEach((u, i) => handle(u, results[i]!));
      if (batchPages >= BATCH_PAGES) {
        batchPages = 0;
        yield flush();
      }
    }
    const last = flush();
    last.crawlEnd = { read, notRead: frontier.size };
    yield last;
  }
}

/** The site's home page, parsed, or null when it cannot be read (for "Verify"). */
export async function readHomePage(
  siteUrl: string,
  ctx: ConnectorContext,
): Promise<HtmlPage | null> {
  const site = new URL(normalizeSiteUrl(siteUrl));
  const fetched = await new SiteClient(site, ctx, limitsOf(ctx)).page(new URL(site.toString()));
  return fetched.kind === 'html' ? fetched.page : null;
}
