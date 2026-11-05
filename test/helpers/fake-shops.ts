import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';

/**
 * Plays Shopify's GraphQL Admin API, WooCommerce's REST API, a published Google Sheet and a
 * photo host on one local port, for catalog sync tests (ADR 0023). Only what Sellora's
 * connectors ask for; the data is plain objects the tests change between syncs.
 */

/** Made up; not shaped like a real Shopify token, so secret scanners do not flag it. */
export const SHOPIFY_TOKEN = 'test-shopify-token-not-real-0001';
export const WOO_KEY = 'ck_0000000000000000000000000000000000000001';
export const WOO_SECRET = 'cs_0000000000000000000000000000000000000001';

export interface FakeShopifyVariant {
  id: string;
  sku: string | null;
  price: string;
  compareAtPrice?: string | null;
  inventoryQuantity: number | null;
  tracked: boolean;
  options: Record<string, string>;
}

export interface FakeShopifyProduct {
  id: string;
  title: string;
  descriptionHtml: string;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  productType: string;
  tags: string[];
  options: { name: string; values: string[] }[];
  images: string[];
  variants: FakeShopifyVariant[];
}

export interface FakeWooProduct {
  id: number;
  name: string;
  type: 'simple' | 'variable' | 'external';
  status: string;
  description: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: string;
  categories: { name: string }[];
  images: string[];
  attributes: { name: string; options: string[]; variation: boolean }[];
  variations: {
    id: number;
    sku: string;
    price: string;
    regular_price: string;
    sale_price: string;
    manage_stock: boolean | 'parent';
    stock_quantity: number | null;
    stock_status: string;
    attributes: { name: string; option: string }[];
  }[];
}

const VARIANTS_PAGE = 50;

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(
  res: ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

export class FakeShops {
  private server!: Server;
  base = '';
  readonly shopify = {
    name: 'Nakshi Shopify',
    currency: 'BDT',
    products: [] as FakeShopifyProduct[],
    /** Answer the next N GraphQL calls with THROTTLED. */
    throttle: 0,
    /** Answer every call with this HTTP status (e.g. 500), when set. */
    failWith: null as number | null,
  };
  readonly woo = {
    name: 'Nakshi Woo',
    currency: 'BDT',
    products: [] as FakeWooProduct[],
  };
  /** The sheet at /sheet.csv; /private-sheet answers like a sheet that is not shared. */
  sheet = '';
  /** Photo requests by path, to tell whether a sync fetched a photo again. */
  readonly photoHits = new Map<string, number>();
  private png!: Buffer;

  async start(): Promise<void> {
    this.png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#c0392b' },
    })
      .png()
      .toBuffer();
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        json(res, 500, { error: String(err) });
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  photo(name: string): string {
    return `${this.base}/img/${name}.png`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base);
    const path = url.pathname;
    if (path.startsWith('/img/')) {
      this.photoHits.set(path, (this.photoHits.get(path) ?? 0) + 1);
      if (path.includes('missing')) return json(res, 404, { error: 'gone' });
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(this.png);
      return;
    }
    if (path === '/sheet.csv') {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="Catalog - Sheet1.csv"',
      });
      res.end(this.sheet);
      return;
    }
    if (path === '/private-sheet') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>Sign in to continue</body></html>');
      return;
    }
    if (/^\/shopify\/admin\/api\/[\d-]+\/graphql\.json$/.test(path) && req.method === 'POST')
      return this.shopifyGraphql(req, res);
    if (path.startsWith('/woo/wp-json')) return this.wooRest(req, res, url);
    json(res, 404, { error: 'not found' });
  }

  private async shopifyGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { query, variables } = JSON.parse(await body(req)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (this.shopify.failWith) return json(res, this.shopify.failWith, { errors: 'down' });
    if (req.headers['x-shopify-access-token'] !== SHOPIFY_TOKEN)
      return json(res, 401, { errors: '[API] Invalid API key or access token' });
    if (this.shopify.throttle > 0) {
      this.shopify.throttle -= 1;
      return json(res, 200, {
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
      });
    }
    const variantNode = (v: FakeShopifyVariant) => ({
      id: v.id,
      sku: v.sku,
      barcode: null,
      price: v.price,
      compareAtPrice: v.compareAtPrice ?? null,
      inventoryQuantity: v.inventoryQuantity,
      selectedOptions: Object.entries(v.options).map(([name, value]) => ({ name, value })),
      inventoryItem: { tracked: v.tracked },
    });
    const variantsPage = (p: FakeShopifyProduct, after: number) => {
      const slice = p.variants.slice(after, after + VARIANTS_PAGE);
      return {
        pageInfo: {
          hasNextPage: after + VARIANTS_PAGE < p.variants.length,
          endCursor: String(after + slice.length),
        },
        nodes: slice.map(variantNode),
      };
    };
    if (query.includes('SelloraCheck'))
      return json(res, 200, {
        data: {
          shop: { name: this.shopify.name, currencyCode: this.shopify.currency },
          productsCount: { count: this.shopify.products.length },
        },
      });
    if (query.includes('SelloraVariants')) {
      const p = this.shopify.products.find((x) => x.id === variables.id);
      return json(res, 200, {
        data: { product: p ? { variants: variantsPage(p, Number(variables.after ?? 0)) } : null },
      });
    }
    if (query.includes('SelloraProducts')) {
      const first = Number(variables.first);
      const after = variables.after ? Number(variables.after) : 0;
      const slice = this.shopify.products.slice(after, after + first);
      return json(res, 200, {
        data: {
          products: {
            pageInfo: {
              hasNextPage: after + first < this.shopify.products.length,
              endCursor: String(after + slice.length),
            },
            nodes: slice.map((p) => ({
              id: p.id,
              title: p.title,
              descriptionHtml: p.descriptionHtml,
              status: p.status,
              productType: p.productType,
              tags: p.tags,
              options: p.options.map((o) => ({
                name: o.name,
                optionValues: o.values.map((name) => ({ name })),
              })),
              media: { nodes: p.images.map((url) => ({ image: { url, altText: null } })) },
              variants: variantsPage(p, 0),
            })),
          },
        },
      });
    }
    return json(res, 200, { errors: [{ message: 'Unknown query' }] });
  }

  private wooRest(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const path = url.pathname.replace(/^\/woo\/wp-json/, '');
    if (path === '' || path === '/') return json(res, 200, { name: this.woo.name });
    const expected = `Basic ${Buffer.from(`${WOO_KEY}:${WOO_SECRET}`).toString('base64')}`;
    if (req.headers.authorization !== expected)
      return json(res, 401, {
        code: 'woocommerce_rest_cannot_view',
        message: 'Sorry, you cannot list resources.',
      });
    if (path === '/wc/v3/data/currencies/current')
      return json(res, 200, { code: this.woo.currency, name: 'Bangladeshi taka', symbol: '৳' });
    const perPage = Number(url.searchParams.get('per_page') ?? 10);
    const page = Number(url.searchParams.get('page') ?? 1);
    const paged = <T>(items: T[]) => {
      const slice = items.slice((page - 1) * perPage, page * perPage);
      return json(res, 200, slice, {
        'x-wp-total': String(items.length),
        'x-wp-totalpages': String(Math.max(1, Math.ceil(items.length / perPage))),
      });
    };
    if (path === '/wc/v3/products')
      return paged(
        this.woo.products.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          status: p.status,
          description: p.description,
          short_description: '',
          sku: p.sku,
          price: p.price,
          regular_price: p.regular_price,
          sale_price: p.sale_price,
          manage_stock: p.manage_stock,
          stock_quantity: p.stock_quantity,
          stock_status: p.stock_status,
          categories: p.categories,
          tags: [],
          images: p.images.map((src) => ({ src, alt: '' })),
          attributes: p.attributes,
        })),
      );
    const variations = /^\/wc\/v3\/products\/(\d+)\/variations$/.exec(path);
    if (variations) {
      const p = this.woo.products.find((x) => x.id === Number(variations[1]));
      if (!p) return json(res, 404, { code: 'woocommerce_rest_product_invalid_id' });
      return paged(p.variations.map((v) => ({ ...v, status: 'publish', image: null })));
    }
    return json(res, 404, { code: 'rest_no_route' });
  }
}
