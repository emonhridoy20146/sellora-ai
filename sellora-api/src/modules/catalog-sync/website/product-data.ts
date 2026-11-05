import { htmlToPlainText } from '../../../common/text/html-text.js';
import { parsePrice, type SourceProblem, type SourceProduct } from '../source-product.js';
import type { HtmlPage } from './html-page.js';

/**
 * Products from a page's structured data (ADR 0024): schema.org `Product` / `ProductGroup` in
 * JSON-LD, or OpenGraph product tags when there is no JSON-LD product. One product per page:
 * a page with several top-level products is a list (a category page) and gives none, and a
 * product whose `url` names another page belongs to that page.
 */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Node = { [k: string]: Json };

export type Availability = 'in_stock' | 'sold_out' | 'discontinued';

export interface PageProducts {
  product: SourceProduct | null;
  problems: SourceProblem[];
  /** The page has product data, even if it could not be imported (so it is a product page). */
  hasProductData: boolean;
}

const isNode = (v: Json | undefined): v is Node =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: Json | undefined): Json[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

function types(n: Node): string[] {
  return list(n['@type']).flatMap((t) =>
    typeof t === 'string' ? [t.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase()] : [],
  );
}

function text(v: Json | undefined): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (isNode(v)) return text(v.name ?? v['@value'] ?? v.value);
  if (Array.isArray(v)) return text(v[0]);
  return '';
}

/** JSON-LD as sites print it: stray control characters, HTML comments, CDATA wrappers. */
export function parseJsonLd(raw: string): Json[] {
  const cleaned = raw
    .replace(/^\s*<!--|-->\s*$/g, '')
    .replace(/^\s*\/\/\s*<!\[CDATA\[|\/\/\s*\]\]>\s*$/g, '')
    // eslint-disable-next-line no-control-regex -- control characters are what is removed
    .replace(/[\u0000-\u001f]+/g, ' ')
    .trim();
  if (!cleaned) return [];
  try {
    return list(JSON.parse(cleaned) as Json);
  } catch {
    // Trailing commas are the commonest hand-written mistake.
    try {
      return list(JSON.parse(cleaned.replace(/,\s*([}\]])/g, '$1')) as Json);
    } catch {
      return [];
    }
  }
}

/** Top-level product nodes: the root values, `@graph` entries and a page's `mainEntity`. */
function productNodes(blocks: Json[]): Node[] {
  const out: Node[] = [];
  const visit = (v: Json, depth: number) => {
    if (!isNode(v) || depth > 3) return;
    const t = types(v);
    if (t.includes('product') || t.includes('productgroup')) {
      out.push(v);
      return;
    }
    for (const g of list(v['@graph'])) visit(g, depth + 1);
    for (const m of list(v.mainEntity)) visit(m, depth + 1);
  };
  for (const b of blocks) visit(b, 0);
  return out;
}

export function resolveUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function images(v: Json | undefined, base: string): { url: string; alt?: string }[] {
  const out: { url: string; alt?: string }[] = [];
  for (const item of list(v)) {
    const href =
      typeof item === 'string' ? item : isNode(item) ? text(item.url ?? item.contentUrl) : '';
    const url = href && resolveUrl(href, base);
    if (!url) continue;
    const alt = isNode(item) ? text(item.caption ?? item.name) : '';
    out.push(alt ? { url, alt } : { url });
  }
  return out;
}

export function availabilityOf(v: Json | undefined): Availability | null {
  const raw = text(v).toLowerCase();
  if (!raw) return null;
  const key = raw.replace(/^https?:\/\/schema\.org\//, '').replace(/[\s_-]/g, '');
  if (['outofstock', 'soldout', 'oos'].includes(key)) return 'sold_out';
  if (key === 'discontinued') return 'discontinued';
  if (
    [
      'instock',
      'instoreonly',
      'onlineonly',
      'limitedavailability',
      'preorder',
      'presale',
      'backorder',
      'madetoorder',
      'available',
      'availablefororder',
    ].includes(key)
  )
    return 'in_stock';
  return null;
}

interface Price {
  priceMinor: number;
  compareAtPriceMinor?: number;
  currency: string | null;
  availability: Availability | null;
  sku?: string;
  name?: string;
}

type OfferResult = { prices: Price[] } | { range: { low: string; high: string } } | { none: true };

function priceSpec(
  offer: Node,
  currency: string,
): { price: number | null; compare?: number; cur: string | null } {
  let price: number | null = parsePrice(offer.price ?? null, currency);
  let compare: number | undefined;
  let cur = text(offer.priceCurrency) || null;
  for (const spec of list(offer.priceSpecification)) {
    if (!isNode(spec)) continue;
    const kind = text(spec.priceType)
      .toLowerCase()
      .replace(/^https?:\/\/schema\.org\//, '');
    const value = parsePrice(spec.price ?? null, currency);
    if (value === null) continue;
    if (kind === 'strikethroughprice' || kind === 'listprice' || kind === 'msrp') compare = value;
    else if (price === null) price = value;
    cur ??= text(spec.priceCurrency) || null;
  }
  return { price, ...(compare !== undefined ? { compare } : {}), cur };
}

function offerPrices(v: Json | undefined, currency: string): OfferResult {
  const prices: Price[] = [];
  for (const o of list(v)) {
    if (!isNode(o)) continue;
    if (types(o).includes('aggregateoffer')) {
      if (list(o.offers).length) {
        const inner = offerPrices(o.offers, currency);
        if ('prices' in inner) prices.push(...inner.prices);
        else return inner;
        continue;
      }
      const low = parsePrice(o.lowPrice ?? o.price ?? null, currency);
      const high = parsePrice(o.highPrice ?? null, currency);
      if (low === null) continue;
      if (high !== null && high !== low)
        return { range: { low: text(o.lowPrice), high: text(o.highPrice) } };
      prices.push({
        priceMinor: low,
        currency: text(o.priceCurrency) || null,
        availability: availabilityOf(o.availability),
      });
      continue;
    }
    const spec = priceSpec(o, currency);
    if (spec.price === null) continue;
    const item = isNode(o.itemOffered) ? o.itemOffered : null;
    const sku = text(o.sku) || (item ? text(item.sku) : '');
    const name = text(o.name) || (item ? text(item.name) : '');
    prices.push({
      priceMinor: spec.price,
      ...(spec.compare !== undefined ? { compareAtPriceMinor: spec.compare } : {}),
      currency: spec.cur,
      availability: availabilityOf(o.availability),
      ...(sku ? { sku } : {}),
      ...(name ? { name } : {}),
    });
  }
  return prices.length ? { prices } : { none: true };
}

const OPTION_PROPS: Record<string, string> = {
  size: 'Size',
  color: 'Colour',
  colour: 'Colour',
  material: 'Material',
  pattern: 'Pattern',
  suggestedgender: 'Gender',
  suggestedage: 'Age',
};

function optionKey(raw: string): string {
  return raw.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase();
}

function stockOf(availability: Availability | null): { trackStock: boolean; stock: number } {
  // A website says "in stock" or "sold out", never how many (ADR 0024): sold out is a
  // counted 0, available is "not counted".
  return availability === 'sold_out'
    ? { trackStock: true, stock: 0 }
    : { trackStock: false, stock: 0 };
}

const barcodeOf = (n: Node): string =>
  text(n.gtin13 ?? n.gtin ?? n.gtin12 ?? n.gtin14 ?? n.gtin8 ?? null);

function categoryOf(n: Node): string | undefined {
  const raw = text(n.category);
  if (!raw) return undefined;
  const last = raw
    .split(/\s*[>/|]\s*/)
    .filter(Boolean)
    .pop();
  return last && !/^https?:/i.test(last) ? last : undefined;
}

function tagsOf(n: Node): string[] {
  const out: string[] = [];
  const brand = isNode(n.brand) ? text(n.brand.name) : text(n.brand);
  if (brand) out.push(brand);
  for (const k of list(n.keywords))
    if (typeof k === 'string')
      out.push(
        ...k
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
  return out.slice(0, 30);
}

function belongsElsewhere(n: Node, pageUrl: string): boolean {
  const own = text(n.url);
  if (!own) return false;
  const resolved = resolveUrl(own, pageUrl);
  if (!resolved) return false;
  const a = new URL(resolved);
  const b = new URL(pageUrl);
  return a.host !== b.host || a.pathname.replace(/\/$/, '') !== b.pathname.replace(/\/$/, '');
}

interface Built {
  product: SourceProduct | null;
  problem?: SourceProblem;
}

function fromProductNode(
  n: Node,
  ctx: { pageUrl: string; externalId: string; currency: string },
): Built {
  const name = text(n.name);
  const ref = name || ctx.pageUrl;
  const description = htmlToPlainText(text(n.description));
  const base = {
    externalId: ctx.externalId,
    name,
    description,
    tags: tagsOf(n),
    ...(categoryOf(n) ? { category: categoryOf(n)! } : {}),
    images: images(n.image, ctx.pageUrl),
  };
  const currencyProblem = (cur: string | null): SourceProblem | undefined =>
    cur && cur.toUpperCase() !== ctx.currency
      ? {
          ref,
          message: `It is priced in ${cur.toUpperCase()}; the business sells in ${ctx.currency}. Prices are not converted.`,
          skipped: true,
        }
      : undefined;

  // A product group: each variant is a product with its own offer and option values.
  if (types(n).includes('productgroup') && list(n.hasVariant).length) {
    const variesBy = list(n.variesBy).map((v) => optionKey(text(v)));
    const variants = list(n.hasVariant).filter(isNode);
    const keys = variesBy.length
      ? variesBy
      : Object.keys(OPTION_PROPS).filter((k) => variants.some((v) => text(v[k])));
    const options = keys.map((k) => ({
      name: OPTION_PROPS[k] ?? k.charAt(0).toUpperCase() + k.slice(1),
      values: [] as string[],
    }));
    const out: SourceProduct['variants'] = [];
    let availabilities = 0;
    let discontinued = 0;
    for (const v of variants) {
      const offer = offerPrices(v.offers, ctx.currency);
      if (!('prices' in offer)) continue;
      const p = offer.prices[0]!;
      const bad = currencyProblem(p.currency);
      if (bad) return { product: null, problem: bad };
      const values = keys.map((k) => text(v[k]));
      values.forEach((val, i) => {
        if (val && !options[i]!.values.includes(val)) options[i]!.values.push(val);
      });
      if (p.availability) availabilities += 1;
      if (p.availability === 'discontinued') discontinued += 1;
      const sku = text(v.sku) || p.sku;
      const barcode = barcodeOf(v);
      out.push({
        externalId: sku || text(v['@id']) || values.join(' / ') || String(out.length),
        optionValues: values,
        ...(sku ? { sku } : {}),
        ...(barcode ? { barcode } : {}),
        priceMinor: p.priceMinor,
        ...(p.compareAtPriceMinor !== undefined
          ? { compareAtPriceMinor: p.compareAtPriceMinor }
          : {}),
        ...stockOf(p.availability),
      });
    }
    if (!out.length)
      return {
        product: null,
        problem: { ref, message: 'Its choices have no price on the page.', skipped: true },
      };
    const allImages = base.images.length
      ? base.images
      : variants.flatMap((v) => images(v.image, ctx.pageUrl));
    return {
      product: {
        ...base,
        images: allImages,
        active: !(availabilities > 0 && discontinued === out.length),
        options: options.filter((o) => o.values.length),
        variants: out,
      },
    };
  }

  const offer = offerPrices(n.offers, ctx.currency);
  if ('range' in offer)
    return {
      product: null,
      problem: {
        ref,
        message: `The page gives a price range (${offer.range.low}–${offer.range.high}) but not each choice's price, so it was not imported. Connect the shop's API (Shopify or WooCommerce) for products with choices.`,
        skipped: true,
      },
    };
  if ('none' in offer)
    return {
      product: null,
      problem: { ref, message: 'The page has no price for it.', skipped: true },
    };
  const bad = currencyProblem(offer.prices.find((p) => p.currency)?.currency ?? null);
  if (bad) return { product: null, problem: bad };

  const sku = text(n.sku);
  const barcode = barcodeOf(n);
  const distinct = new Set(
    offer.prices.map((p) => `${p.priceMinor}|${p.sku ?? ''}|${p.name ?? ''}`),
  );
  if (offer.prices.length > 1 && distinct.size > 1) {
    // Several offers, each its own choice ("Option: 500 g", "Option: 1 kg").
    const values: string[] = [];
    const variants: SourceProduct['variants'] = [];
    offer.prices.forEach((p, i) => {
      let label = (p.name && p.name !== name ? p.name : p.sku) || `Choice ${i + 1}`;
      while (values.includes(label)) label = `${label} (${i + 1})`;
      values.push(label);
      variants.push({
        externalId: p.sku || label,
        optionValues: [label],
        ...(p.sku ? { sku: p.sku } : {}),
        priceMinor: p.priceMinor,
        ...(p.compareAtPriceMinor !== undefined
          ? { compareAtPriceMinor: p.compareAtPriceMinor }
          : {}),
        ...stockOf(p.availability),
      });
    });
    return {
      product: {
        ...base,
        active: !offer.prices.every((p) => p.availability === 'discontinued'),
        options: [{ name: 'Option', values }],
        variants,
      },
    };
  }
  const p = offer.prices[0]!;
  return {
    product: {
      ...base,
      active: p.availability !== 'discontinued',
      options: [],
      variants: [
        {
          externalId: sku || 'default',
          optionValues: [],
          ...(sku || p.sku ? { sku: sku || p.sku! } : {}),
          ...(barcode ? { barcode } : {}),
          priceMinor: p.priceMinor,
          ...(p.compareAtPriceMinor !== undefined
            ? { compareAtPriceMinor: p.compareAtPriceMinor }
            : {}),
          ...stockOf(p.availability),
        },
      ],
    },
  };
}

function fromOpenGraph(
  page: HtmlPage,
  ctx: { pageUrl: string; externalId: string; currency: string },
): Built | null {
  const m = page.meta;
  const type = (m['og:type'] ?? '').toLowerCase();
  const amount = m['product:price:amount'] ?? m['og:price:amount'];
  if (!amount || (type && !type.startsWith('product'))) return null;
  const name = (m['og:title'] ?? page.title).trim();
  const ref = name || ctx.pageUrl;
  const priceMinor = parsePrice(amount, ctx.currency);
  if (priceMinor === null)
    return {
      product: null,
      problem: { ref, message: `The price "${amount}" could not be read.`, skipped: true },
    };
  const cur = m['product:price:currency'] ?? m['og:price:currency'];
  if (cur && cur.toUpperCase() !== ctx.currency)
    return {
      product: null,
      problem: {
        ref,
        message: `It is priced in ${cur.toUpperCase()}; the business sells in ${ctx.currency}. Prices are not converted.`,
        skipped: true,
      },
    };
  const availability = availabilityOf(m['product:availability'] ?? m['og:availability']);
  const sku = m['product:retailer_item_id'];
  const image = m['og:image'] ? resolveUrl(m['og:image'], ctx.pageUrl) : null;
  return {
    product: {
      externalId: ctx.externalId,
      name,
      description: (m['og:description'] ?? page.description).trim(),
      active: availability !== 'discontinued',
      tags: [],
      images: image ? [{ url: image }] : [],
      options: [],
      variants: [
        {
          externalId: sku || 'default',
          optionValues: [],
          ...(sku ? { sku } : {}),
          priceMinor,
          ...stockOf(availability),
        },
      ],
    },
  };
}

/** The page's product, if it is a product page. `externalId` is the page's key. */
export function pageProducts(
  page: HtmlPage,
  ctx: { pageUrl: string; externalId: string; currency: string },
): PageProducts {
  const nodes = productNodes(page.jsonLd.flatMap(parseJsonLd)).filter(
    (n) => !belongsElsewhere(n, ctx.pageUrl),
  );
  if (nodes.length > 1) {
    const names = new Set(nodes.map((n) => text(n.name).toLowerCase()));
    // The same product described twice (two plugins) is still one product page.
    if (names.size > 1) return { product: null, problems: [], hasProductData: false };
  }
  if (nodes.length) {
    const built = fromProductNode(nodes[0]!, ctx);
    return {
      product: built.product,
      problems: built.problem ? [built.problem] : [],
      hasProductData: true,
    };
  }
  const og = fromOpenGraph(page, ctx);
  if (og)
    return { product: og.product, problems: og.problem ? [og.problem] : [], hasProductData: true };
  return { product: null, problems: [], hasProductData: false };
}
