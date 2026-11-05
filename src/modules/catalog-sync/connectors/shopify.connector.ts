import { setTimeout as sleep } from 'node:timers/promises';
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
 * Shopify through the GraphQL Admin API (ADR 0023), with an Admin API access token from an
 * app the merchant made in their Shopify admin (read_products, read_inventory). Queries are
 * kept under Shopify's 1,000-point limit per request: 6 products a page, 50 variants each,
 * and a follow-up query for products with more variants (up to 100).
 */

const WHAT = 'Shopify';
const PAGE = 6;
const VARIANTS_PAGE = 50;
const MAX_VARIANTS = 100;
const MEDIA = 8;
const THROTTLE_WAITS = 6;

const VARIANT_FIELDS = `
  id sku barcode price compareAtPrice inventoryQuantity
  selectedOptions { name value }
  inventoryItem { tracked }`;

const PRODUCTS_QUERY = `
query SelloraProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title descriptionHtml status productType tags
      options { name optionValues { name } }
      media(first: ${MEDIA}) { nodes { ... on MediaImage { image { url altText } } } }
      variants(first: ${VARIANTS_PAGE}) {
        pageInfo { hasNextPage endCursor }
        nodes { ${VARIANT_FIELDS} }
      }
    }
  }
}`;

const MORE_VARIANTS_QUERY = `
query SelloraVariants($id: ID!, $after: String) {
  product(id: $id) {
    variants(first: ${VARIANTS_PAGE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${VARIANT_FIELDS} }
    }
  }
}`;

const CHECK_QUERY = `
query SelloraCheck {
  shop { name currencyCode }
  productsCount { count }
}`;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ShopifyVariant {
  id: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  selectedOptions: { name: string; value: string }[];
  inventoryItem: { tracked: boolean } | null;
}

interface ShopifyProduct {
  id: string;
  title: string;
  descriptionHtml: string;
  status: string;
  productType: string;
  tags: string[];
  options: { name: string; optionValues: { name: string }[] }[];
  media: { nodes: { image?: { url: string; altText: string | null } }[] };
  variants: { pageInfo: PageInfo; nodes: ShopifyVariant[] };
}

interface GraphQlAnswer<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/**
 * "mystore", "mystore.myshopify.com" or "https://mystore.myshopify.com/admin" as
 * https://mystore.myshopify.com. Other addresses only when private networks are allowed
 * (a local stand-in).
 */
export function normalizeShopifyUrl(input: string, allowAny: boolean): string {
  const text = input.trim().replace(/\/+$/, '');
  const bare = /^[a-z0-9][a-z0-9-]{0,62}$/i.exec(text);
  if (bare) return `https://${text.toLowerCase()}.myshopify.com`;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new SourceError('bad_input', 'Enter your shop as name.myshopify.com.');
  }
  if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(url.hostname))
    return `https://${url.hostname.toLowerCase()}`;
  if (allowAny) return `${url.origin}${url.pathname.replace(/\/admin.*$/, '').replace(/\/+$/, '')}`;
  throw new SourceError(
    'bad_input',
    'Use your shop’s .myshopify.com address (Shopify admin › Settings › Domains).',
  );
}

async function graphql<T>(
  input: ConnectorInput,
  ctx: ConnectorContext,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const token = input.credentials?.accessToken;
  if (!input.url || !token) throw new SourceError('bad_input', 'The Shopify token is missing.');
  const url = `${input.url}/admin/api/${ctx.setting('SHOPIFY_API_VERSION')}/graphql.json`;
  for (let wait = 0; ; wait++) {
    const res = await call(
      ctx,
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-shopify-access-token': token,
        },
        body: JSON.stringify({ query, variables }),
      },
      WHAT,
    );
    const answer = parseJson<GraphQlAnswer<T>>(res, WHAT);
    const errors = answer.errors ?? [];
    if (errors.some((e) => e.extensions?.code === 'THROTTLED')) {
      if (wait >= THROTTLE_WAITS)
        throw new SourceError(
          'rate_limited',
          'Shopify is busy (too many requests). Sellora will try again.',
        );
      await sleep(2000);
      continue;
    }
    if (errors.some((e) => e.extensions?.code === 'ACCESS_DENIED'))
      throw new SourceError(
        'auth',
        'Shopify refused: the app needs the read_products and read_inventory permissions.',
      );
    if (errors.length || !answer.data)
      throw new SourceError(
        'bad_response',
        `Shopify did not answer the question: ${errors[0]?.message ?? 'no data'}.`,
      );
    return answer.data;
  }
}

function toSourceProduct(
  p: ShopifyProduct,
  variants: ShopifyVariant[],
  currency: string,
  problems: SourceProblem[],
): SourceProduct | null {
  const options = p.options.map((o) => ({
    name: o.name,
    values: o.optionValues.map((v) => v.name),
  }));
  const mapped: SourceProduct['variants'] = [];
  for (const v of variants) {
    const price = parsePrice(v.price, currency);
    if (price === null) {
      problems.push({ ref: p.title, message: `A variant has no usable price (${v.price}).` });
      continue;
    }
    const compare = v.compareAtPrice ? parsePrice(v.compareAtPrice, currency) : null;
    const tracked = v.inventoryItem?.tracked ?? false;
    mapped.push({
      externalId: v.id,
      optionValues: options.map(
        (o) => v.selectedOptions.find((s) => s.name === o.name)?.value ?? '',
      ),
      ...(v.sku ? { sku: v.sku } : {}),
      ...(v.barcode ? { barcode: v.barcode } : {}),
      priceMinor: price,
      ...(compare !== null ? { compareAtPriceMinor: compare } : {}),
      trackStock: tracked,
      stock: tracked ? (parseCount(v.inventoryQuantity) ?? 0) : 0,
    });
  }
  if (!mapped.length) return null;
  return {
    externalId: p.id,
    name: p.title,
    description: htmlToPlainText(p.descriptionHtml ?? ''),
    active: p.status === 'ACTIVE',
    tags: p.tags ?? [],
    ...(p.productType ? { category: p.productType } : {}),
    images: p.media.nodes.flatMap((m) =>
      m.image?.url
        ? [{ url: m.image.url, ...(m.image.altText ? { alt: m.image.altText } : {}) }]
        : [],
    ),
    options,
    variants: mapped,
  };
}

export class ShopifyConnector implements CatalogConnector {
  readonly kind = 'shopify' as const;

  async check(input: ConnectorInput, ctx: ConnectorContext): Promise<SourceCheck> {
    const info = await graphql<{
      shop: { name: string; currencyCode: string };
      productsCount: { count: number } | null;
    }>(input, ctx, CHECK_QUERY, {});
    const problems: SourceProblem[] = [];
    const sample: SourceProduct[] = [];
    const page = await graphql<{ products: { nodes: ShopifyProduct[] } }>(
      input,
      ctx,
      PRODUCTS_QUERY,
      { first: 5, after: null },
    );
    for (const p of page.products.nodes) {
      const sp = toSourceProduct(p, p.variants.nodes, input.currency, problems);
      if (sp) sample.push(sp);
    }
    return {
      title: info.shop.name,
      currency: info.shop.currencyCode,
      productCount: info.productsCount?.count ?? null,
      sample,
      problems,
    };
  }

  async *read(input: ConnectorInput, ctx: ConnectorContext): AsyncGenerator<SourceBatch> {
    let after: string | null = null;
    for (;;) {
      const page: { products: { pageInfo: PageInfo; nodes: ShopifyProduct[] } } = await graphql(
        input,
        ctx,
        PRODUCTS_QUERY,
        { first: PAGE, after },
      );
      const problems: SourceProblem[] = [];
      const products: SourceProduct[] = [];
      for (const p of page.products.nodes) {
        const variants = [...p.variants.nodes];
        let info = p.variants.pageInfo;
        while (info.hasNextPage && variants.length < MAX_VARIANTS) {
          const more: {
            product: { variants: { pageInfo: PageInfo; nodes: ShopifyVariant[] } } | null;
          } = await graphql(input, ctx, MORE_VARIANTS_QUERY, { id: p.id, after: info.endCursor });
          if (!more.product) break;
          variants.push(...more.product.variants.nodes);
          info = more.product.variants.pageInfo;
        }
        if (info.hasNextPage)
          problems.push({
            ref: p.title,
            message: `Only the first ${MAX_VARIANTS} variants are imported.`,
          });
        const sp = toSourceProduct(p, variants.slice(0, MAX_VARIANTS), input.currency, problems);
        if (sp) products.push(sp);
        else problems.push({ ref: p.title, message: 'It has no variant with a price.' });
      }
      yield { products, problems };
      if (!page.products.pageInfo.hasNextPage) return;
      after = page.products.pageInfo.endCursor;
    }
  }
}
