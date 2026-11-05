import { htmlToPlainText } from '../../../common/text/html-text.js';
import {
  parseCount,
  parsePrice,
  type SourceProblem,
  type SourceProduct,
} from '../source-product.js';
import {
  SourceError,
  type CatalogConnector,
  type ConnectorContext,
  type ConnectorInput,
  type SourceBatch,
  type SourceCheck,
} from './connector.js';
import { call, parseJson } from './http.js';

/**
 * WooCommerce through its REST API (`/wp-json/wc/v3`, ADR 0023) with a read-only API key
 * (WooCommerce › Settings › Advanced › REST API), sent as HTTP Basic over HTTPS. Simple and
 * variable products are imported; grouped and external (affiliate) products are not.
 */

const WHAT = 'WooCommerce';
const PAGE = 100;
const MAX_VARIATIONS = 100;

interface WooImage {
  src: string;
  alt?: string;
}

interface WooAttribute {
  name: string;
  options?: string[];
  option?: string;
  variation?: boolean;
}

interface WooProduct {
  id: number;
  name: string;
  type: string;
  status: string;
  description: string;
  short_description: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: string;
  categories: { name: string }[];
  tags: { name: string }[];
  images: WooImage[];
  attributes: WooAttribute[];
}

interface WooVariation {
  id: number;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  manage_stock: boolean | 'parent';
  stock_quantity: number | null;
  stock_status: string;
  status: string;
  image: WooImage | null;
  attributes: WooAttribute[];
}

/** https://shop.example.com (a WordPress in a folder keeps its path). */
export function normalizeWooUrl(input: string): string {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new SourceError('bad_input', 'Enter your shop’s address, like https://shop.example.com.');
  }
  const path = url.pathname.replace(/\/(wp-admin|wp-json|shop)(\/.*)?$/, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

function auth(input: ConnectorInput): Record<string, string> {
  const key = input.credentials?.consumerKey;
  const secret = input.credentials?.consumerSecret;
  if (!input.url || !key || !secret)
    throw new SourceError('bad_input', 'The WooCommerce key and secret are missing.');
  return {
    authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
    accept: 'application/json',
  };
}

async function get<T>(
  input: ConnectorInput,
  ctx: ConnectorContext,
  path: string,
): Promise<{ data: T; total: number | null; pages: number | null }> {
  const res = await call(ctx, `${input.url}/wp-json/wc/v3${path}`, { headers: auth(input) }, WHAT);
  const data = parseJson<T>(res, WHAT);
  const total = Number(res.headers['x-wp-total']);
  const pages = Number(res.headers['x-wp-totalpages']);
  return {
    data,
    total: Number.isFinite(total) ? total : null,
    pages: Number.isFinite(pages) ? pages : null,
  };
}

/** The selling price, and the regular one when the item is on sale. */
function prices(
  item: { price: string; regular_price: string; sale_price: string },
  currency: string,
): { priceMinor: number; compareAtPriceMinor?: number } | null {
  const price = parsePrice(item.price || item.sale_price || item.regular_price, currency);
  if (price === null) return null;
  const regular = parsePrice(item.regular_price, currency);
  return regular !== null && regular > price
    ? { priceMinor: price, compareAtPriceMinor: regular }
    : { priceMinor: price };
}

function stockOf(
  item: { manage_stock: boolean | 'parent'; stock_quantity: number | null; stock_status: string },
  parent?: WooProduct,
): { trackStock: boolean; stock: number } {
  if (item.manage_stock === 'parent' && parent) return stockOf(parent);
  if (item.manage_stock === true)
    return { trackStock: true, stock: parseCount(item.stock_quantity) ?? 0 };
  // Not counted, but marked out of stock: tracked at zero so nobody can order it.
  if (item.stock_status === 'outofstock') return { trackStock: true, stock: 0 };
  return { trackStock: false, stock: 0 };
}

export class WooCommerceConnector implements CatalogConnector {
  readonly kind = 'woocommerce' as const;

  private async toSourceProduct(
    p: WooProduct,
    input: ConnectorInput,
    ctx: ConnectorContext,
    problems: SourceProblem[],
  ): Promise<SourceProduct | null> {
    if (p.type === 'grouped' || p.type === 'external') {
      problems.push({
        ref: p.name,
        message: `${p.type === 'grouped' ? 'Grouped' : 'External'} products are not imported.`,
        skipped: true,
      });
      return null;
    }
    const base = {
      externalId: String(p.id),
      name: p.name,
      description: htmlToPlainText(p.description || p.short_description || ''),
      active: p.status === 'publish',
      tags: p.tags.map((t) => t.name),
      ...(p.categories[0]?.name && p.categories[0].name !== 'Uncategorized'
        ? { category: p.categories[0].name }
        : {}),
      images: p.images.map((i) => ({ url: i.src, ...(i.alt ? { alt: i.alt } : {}) })),
    };
    if (p.type !== 'variable') {
      const price = prices(p, input.currency);
      if (!price) {
        problems.push({ ref: p.name, message: 'It has no price.', skipped: true });
        return null;
      }
      return {
        ...base,
        options: [],
        variants: [
          {
            externalId: String(p.id),
            optionValues: [],
            ...(p.sku ? { sku: p.sku } : {}),
            ...price,
            ...stockOf(p),
          },
        ],
      };
    }
    const attributes = p.attributes.filter((a) => a.variation);
    const variations: WooVariation[] = [];
    for (let page = 1; variations.length < MAX_VARIATIONS; page++) {
      const res = await get<WooVariation[]>(
        input,
        ctx,
        `/products/${p.id}/variations?per_page=${PAGE}&page=${page}`,
      );
      variations.push(...res.data);
      if (res.data.length < PAGE || (res.pages !== null && page >= res.pages)) break;
    }
    const variants: SourceProduct['variants'] = [];
    const extraImages: { url: string }[] = [];
    for (const v of variations.slice(0, MAX_VARIATIONS)) {
      if (v.status && v.status !== 'publish') continue;
      const values = attributes.map(
        (a) => v.attributes.find((x) => x.name === a.name)?.option ?? '',
      );
      if (values.some((x) => !x)) {
        problems.push({
          ref: p.name,
          message: 'A variation set to "any" value was skipped; give it a value in WooCommerce.',
          skipped: true,
        });
        continue;
      }
      const price = prices(v, input.currency);
      if (!price) {
        problems.push({
          ref: p.name,
          message: `The variation ${values.join(' / ')} has no price.`,
          skipped: true,
        });
        continue;
      }
      if (v.image?.src) extraImages.push({ url: v.image.src });
      variants.push({
        externalId: String(v.id),
        optionValues: values,
        ...(v.sku ? { sku: v.sku } : {}),
        ...price,
        ...stockOf(v, p),
      });
    }
    if (!variants.length) {
      problems.push({ ref: p.name, message: 'It has no variation with a price.' });
      return null;
    }
    return {
      ...base,
      images: [...base.images, ...extraImages],
      options: attributes.map((a) => ({ name: a.name, values: a.options ?? [] })),
      variants,
    };
  }

  async check(input: ConnectorInput, ctx: ConnectorContext): Promise<SourceCheck> {
    const currency = await get<{ code: string }>(input, ctx, '/data/currencies/current');
    let title: string | null;
    try {
      const site = await call(
        ctx,
        `${input.url}/wp-json`,
        { headers: { accept: 'application/json' } },
        WHAT,
      );
      title = parseJson<{ name?: string }>(site, WHAT).name?.trim() || null;
    } catch {
      title = null;
    }
    const page = await get<WooProduct[]>(
      input,
      ctx,
      `/products?per_page=5&page=1&orderby=id&order=asc`,
    );
    const problems: SourceProblem[] = [];
    const sample: SourceProduct[] = [];
    for (const p of page.data) {
      const sp = await this.toSourceProduct(
        p,
        { ...input, currency: input.currency },
        ctx,
        problems,
      );
      if (sp) sample.push(sp);
    }
    return {
      title,
      currency: currency.data.code ?? null,
      productCount: page.total,
      sample,
      problems,
    };
  }

  async *read(input: ConnectorInput, ctx: ConnectorContext): AsyncGenerator<SourceBatch> {
    for (let page = 1; ; page++) {
      const res = await get<WooProduct[]>(
        input,
        ctx,
        `/products?per_page=${PAGE}&page=${page}&orderby=id&order=asc&status=any`,
      );
      if (!Array.isArray(res.data))
        throw new SourceError(
          'bad_response',
          'WooCommerce did not answer with a list of products.',
        );
      const problems: SourceProblem[] = [];
      const products: SourceProduct[] = [];
      for (const p of res.data) {
        const sp = await this.toSourceProduct(p, input, ctx, problems);
        if (sp) products.push(sp);
      }
      yield { products, problems };
      if (res.data.length < PAGE || (res.pages !== null && page >= res.pages)) return;
    }
  }
}
