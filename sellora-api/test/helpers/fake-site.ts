import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DnsAnswer } from '../../src/modules/stores/custom-domains.js';
import type { DnsLookup } from '../../src/modules/stores/dns-lookup.js';

/**
 * A merchant's website for the crawl tests (ADR 0024): pages by path, robots.txt, a sitemap,
 * and a request log. Pages are plain objects the tests change between crawls.
 */

export interface FakePage {
  status?: number;
  html?: string;
  headers?: Record<string, string>;
  /** Sends a redirect to this path or address instead. */
  redirect?: string;
}

export interface FakeProduct {
  name: string;
  sku: string;
  price: number;
  availability?: 'InStock' | 'OutOfStock' | 'Discontinued';
  description?: string;
  image?: string;
}

export class FakeSite {
  private server: http.Server | null = null;
  base = '';
  pages = new Map<string, FakePage>();
  robots: { status: number; text: string } = { status: 200, text: '' };
  sitemap: string[] | null = null;
  /** Paths requested, in order, with the user agent. */
  readonly log: { path: string; ua: string }[] = [];

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  paths(): string[] {
    return this.log.map((l) => l.path);
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const path = req.url ?? '/';
    this.log.push({ path, ua: String(req.headers['user-agent'] ?? '') });
    if (path === '/robots.txt') {
      res.writeHead(this.robots.status, { 'content-type': 'text/plain' });
      res.end(this.robots.text);
      return;
    }
    if (path === '/sitemap.xml' && this.sitemap) {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${this.sitemap
          .map((p) => `<url><loc>${this.base}${p}</loc></url>`)
          .join('')}</urlset>`,
      );
      return;
    }
    if (path.startsWith('/img/')) {
      // A 1x1 PNG.
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      return;
    }
    const page = this.pages.get(path);
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<h1>Not found</h1>');
      return;
    }
    if (page.redirect) {
      res.writeHead(301, { location: page.redirect });
      res.end();
      return;
    }
    res.writeHead(page.status ?? 200, {
      'content-type': 'text/html; charset=utf-8',
      ...page.headers,
    });
    res.end(page.html ?? '');
  }
}

/** A page with a title, links, optional head tags and paragraphs. */
export function htmlPage(opts: {
  title: string;
  head?: string;
  body: string;
  links?: string[];
}): string {
  return `<!doctype html><html lang="en"><head><title>${opts.title}</title>${opts.head ?? ''}</head><body>
<header><nav>${(opts.links ?? []).map((l) => `<a href="${l}">${l}</a>`).join(' ')}</nav></header>
<main>${opts.body}</main><footer>© Demo shop</footer></body></html>`;
}

/** schema.org Product JSON-LD for one product page. */
export function productLd(p: FakeProduct): string {
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    sku: p.sku,
    description: p.description ?? `${p.name}, made in Bangladesh.`,
    ...(p.image ? { image: p.image } : {}),
    offers: {
      '@type': 'Offer',
      price: p.price.toFixed(2),
      priceCurrency: 'BDT',
      availability: `https://schema.org/${p.availability ?? 'InStock'}`,
    },
  })}</script>`;
}

/** DNS for the ownership checks: TXT records at `_sellora-verify.<domain>` by domain. */
export class FakeDns implements DnsLookup {
  txt = new Map<string, string[]>();
  unreachable = false;
  readonly asked: string[] = [];

  lookup(domain: string): Promise<DnsAnswer> {
    this.asked.push(domain);
    return Promise.resolve({
      txt: this.txt.get(domain) ?? [],
      cname: [],
      addresses: [],
      unreachable: this.unreachable,
    });
  }
}
