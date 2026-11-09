/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for the shops Sellora imports products from, for trying catalog sync locally
 * (ADR 0023). It is NOT Shopify, WooCommerce or Google: it keeps a few demo products in
 * memory and answers the calls Sellora's connectors make, in the same shapes:
 *
 *   Shopify GraphQL Admin API   http://localhost:4090/shopify    token below
 *   WooCommerce REST API v3     http://localhost:4090/woo        key and secret below
 *   A published sheet (CSV)     http://localhost:4090/sheet.csv
 *   Product photos              http://localhost:4090/img/<name>.png
 *
 *   node scripts/shop-stand-in.mjs     # on http://localhost:4090
 *
 * The API must be allowed to call local addresses, which only development may do:
 *
 *   SYNC_ALLOW_PRIVATE_NETWORK=true    # in sellora-api/.env, then restart the API and the worker
 *
 *   open http://localhost:4090                         # the products, and forms to change them
 *   curl localhost:4090/__state                        # everything as JSON
 *   curl -X POST 'localhost:4090/__price?sku=JAM-RED&price=2950'    # change a price
 *   curl -X POST 'localhost:4090/__stock?sku=JAM-RED&qty=4'         # change a stock count
 *   curl -X POST 'localhost:4090/__hide?shop=shopify&id=1002'       # remove a product
 *   curl -X POST 'localhost:4090/__fail?shop=shopify&status=500'    # the shop answers 500 (0: stop)
 *   curl -X POST 'localhost:4090/__reset'                           # back to the demo products
 */
import { createServer } from 'node:http';
import sharp from 'sharp';

const PORT = Number(process.env.PORT ?? 4090);
const BASE = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const SHOPIFY_TOKEN = 'shpat_standin0000000000000000000000001';
const WOO_KEY = 'ck_standin00000000000000000000000000000001';
const WOO_SECRET = 'cs_standin00000000000000000000000000000001';
const VARIANTS_PAGE = 50;
const img = (name) => `${BASE}/img/${name}.png`;

function demo() {
  return {
    shopify: {
      name: 'Nakshi Ghor on Shopify (stand-in)',
      currency: 'BDT',
      failWith: 0,
      products: [
        {
          id: 'gid://shopify/Product/1001',
          title: 'Jamdani Saree',
          descriptionHtml:
            '<p>Hand-woven <b>Dhakai</b> jamdani from Rupganj.</p><ul><li>6 yards</li><li>Soft cotton</li><li>Blouse piece included</li></ul>',
          status: 'ACTIVE',
          productType: 'Sarees',
          tags: ['saree', 'jamdani', 'eid'],
          options: [{ name: 'Colour', values: ['Red', 'Blue'] }],
          images: [img('jamdani-red'), img('jamdani-blue')],
          variants: [
            {
              id: 'gid://shopify/ProductVariant/1',
              sku: 'JAM-RED',
              price: '3200.00',
              compareAtPrice: '3800.00',
              inventoryQuantity: 7,
              tracked: true,
              options: { Colour: 'Red' },
            },
            {
              id: 'gid://shopify/ProductVariant/2',
              sku: 'JAM-BLUE',
              price: '3200.00',
              compareAtPrice: null,
              inventoryQuantity: 2,
              tracked: true,
              options: { Colour: 'Blue' },
            },
          ],
        },
        {
          id: 'gid://shopify/Product/1002',
          title: 'Nakshi Kantha Cushion Cover',
          descriptionHtml: 'Hand-embroidered cushion cover, 16 × 16 inches.',
          status: 'ACTIVE',
          productType: 'Home',
          tags: ['kantha'],
          options: [{ name: 'Title', values: ['Default Title'] }],
          images: [img('kantha-cushion')],
          variants: [
            {
              id: 'gid://shopify/ProductVariant/3',
              sku: 'KAN-CUSH',
              price: '850.00',
              compareAtPrice: null,
              inventoryQuantity: null,
              tracked: false,
              options: { Title: 'Default Title' },
            },
          ],
        },
        {
          id: 'gid://shopify/Product/1003',
          title: 'Eid Panjabi',
          descriptionHtml: '<p>Cotton panjabi with embroidered collar.</p>',
          status: 'ACTIVE',
          productType: 'Panjabi',
          tags: ['eid', 'men'],
          options: [{ name: 'Size', values: ['M', 'L', 'XL'] }],
          images: [img('panjabi-white')],
          variants: [
            {
              id: 'gid://shopify/ProductVariant/4',
              sku: 'PJ-M',
              price: '1850.00',
              compareAtPrice: '2200.00',
              inventoryQuantity: 6,
              tracked: true,
              options: { Size: 'M' },
            },
            {
              id: 'gid://shopify/ProductVariant/5',
              sku: 'PJ-L',
              price: '1850.00',
              compareAtPrice: '2200.00',
              inventoryQuantity: 4,
              tracked: true,
              options: { Size: 'L' },
            },
            {
              id: 'gid://shopify/ProductVariant/6',
              sku: 'PJ-XL',
              price: '1950.00',
              compareAtPrice: '2300.00',
              inventoryQuantity: 0,
              tracked: true,
              options: { Size: 'XL' },
            },
          ],
        },
        {
          id: 'gid://shopify/Product/1004',
          title: 'Winter Shawl (draft)',
          descriptionHtml: '',
          status: 'DRAFT',
          productType: '',
          tags: [],
          options: [{ name: 'Title', values: ['Default Title'] }],
          images: [],
          variants: [
            {
              id: 'gid://shopify/ProductVariant/7',
              sku: 'SHAWL-1',
              price: '1500.00',
              compareAtPrice: null,
              inventoryQuantity: 3,
              tracked: true,
              options: { Title: 'Default Title' },
            },
          ],
        },
      ],
    },
    woo: {
      name: 'Nakshi Ghor on WooCommerce (stand-in)',
      currency: 'BDT',
      failWith: 0,
      products: [
        {
          id: 11,
          name: 'Clay Pot',
          type: 'simple',
          status: 'publish',
          description: '<p>Hand-made terracotta pot from Bogura.</p>',
          sku: 'POT-1',
          price: '450',
          regular_price: '500',
          sale_price: '450',
          manage_stock: true,
          stock_quantity: 12,
          stock_status: 'instock',
          categories: [{ name: 'Home' }],
          images: [img('clay-pot')],
          attributes: [],
          variations: [],
        },
        {
          id: 12,
          name: 'Cotton Lungi',
          type: 'variable',
          status: 'publish',
          description: 'Check lungi, pure cotton.',
          sku: '',
          price: '650',
          regular_price: '',
          sale_price: '',
          manage_stock: true,
          stock_quantity: 9,
          stock_status: 'instock',
          categories: [{ name: 'Men' }],
          images: [img('lungi')],
          attributes: [{ name: 'Colour', options: ['Green', 'Blue'], variation: true }],
          variations: [
            {
              id: 121,
              sku: 'LG-GREEN',
              price: '650',
              regular_price: '650',
              sale_price: '',
              manage_stock: true,
              stock_quantity: 5,
              stock_status: 'instock',
              attributes: [{ name: 'Colour', option: 'Green' }],
            },
            {
              id: 122,
              sku: 'LG-BLUE',
              price: '650',
              regular_price: '650',
              sale_price: '',
              manage_stock: 'parent',
              stock_quantity: null,
              stock_status: 'instock',
              attributes: [{ name: 'Colour', option: 'Blue' }],
            },
          ],
        },
      ],
    },
    sheet: [
      'Handle,Name,Price,Old price,SKU,Stock,Size,Category,Image,Description',
      `three-piece,Lawn Three-Piece,"৳2,450",2900,TP-M,5,M,Women,${img('three-piece')},Printed lawn with chiffon dupatta.`,
      'three-piece,,"2,450",,TP-L,3,L,,,',
      'three-piece,,২৫৫০,,TP-XL,০,XL,,,',
      ',Gamchha,120 টাকা,,GM-1,in stock,,Home,,Cotton gamchha.',
      ',Bamboo Basket,abc,,BB-1,4,,Home,,',
    ].join('\n'),
  };
}

let state = demo();
const photoCache = new Map();

/** A plain coloured square per photo name, so each product has its own picture. */
async function photo(name) {
  if (photoCache.has(name)) return photoCache.get(name);
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const background = { r: 90 + (h % 140), g: 60 + ((h >> 8) % 140), b: 60 + ((h >> 16) % 140) };
  const png = await sharp({ create: { width: 480, height: 480, channels: 3, background } })
    .png()
    .toBuffer();
  photoCache.set(name, png);
  return png;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function shopify(query, variables) {
  const s = state.shopify;
  const variantNode = (v) => ({
    id: v.id,
    sku: v.sku,
    barcode: null,
    price: v.price,
    compareAtPrice: v.compareAtPrice ?? null,
    inventoryQuantity: v.inventoryQuantity,
    selectedOptions: Object.entries(v.options).map(([name, value]) => ({ name, value })),
    inventoryItem: { tracked: v.tracked },
  });
  const variantsPage = (p, after) => {
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
    return {
      data: {
        shop: { name: s.name, currencyCode: s.currency },
        productsCount: { count: s.products.length },
      },
    };
  if (query.includes('SelloraVariants')) {
    const p = s.products.find((x) => x.id === variables.id);
    return {
      data: { product: p ? { variants: variantsPage(p, Number(variables.after ?? 0)) } : null },
    };
  }
  if (query.includes('SelloraProducts')) {
    const first = Number(variables.first);
    const after = variables.after ? Number(variables.after) : 0;
    const slice = s.products.slice(after, after + first);
    return {
      data: {
        products: {
          pageInfo: {
            hasNextPage: after + first < s.products.length,
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
    };
  }
  return { errors: [{ message: 'Unknown query (the stand-in only knows Sellora’s queries)' }] };
}

function woo(req, res, url) {
  const w = state.woo;
  const path = url.pathname.replace(/^\/woo\/wp-json/, '');
  if (path === '' || path === '/') return json(res, 200, { name: w.name });
  if (w.failWith) return json(res, w.failWith, { code: 'stand_in_failure', message: 'Down' });
  const expected = `Basic ${Buffer.from(`${WOO_KEY}:${WOO_SECRET}`).toString('base64')}`;
  if (req.headers.authorization !== expected)
    return json(res, 401, {
      code: 'woocommerce_rest_cannot_view',
      message: 'Sorry, you cannot list resources.',
    });
  if (path === '/wc/v3/data/currencies/current')
    return json(res, 200, { code: w.currency, name: 'Bangladeshi taka', symbol: '৳' });
  const perPage = Number(url.searchParams.get('per_page') ?? 10);
  const page = Number(url.searchParams.get('page') ?? 1);
  const paged = (items) =>
    json(res, 200, items.slice((page - 1) * perPage, page * perPage), {
      'x-wp-total': String(items.length),
      'x-wp-totalpages': String(Math.max(1, Math.ceil(items.length / perPage))),
    });
  if (path === '/wc/v3/products')
    return paged(
      w.products.map(({ variations: _v, images, ...p }) => ({
        ...p,
        short_description: '',
        tags: [],
        images: images.map((src) => ({ src, alt: '' })),
      })),
    );
  const m = /^\/wc\/v3\/products\/(\d+)\/variations$/.exec(path);
  if (m) {
    const p = w.products.find((x) => x.id === Number(m[1]));
    if (!p) return json(res, 404, { code: 'woocommerce_rest_product_invalid_id' });
    return paged(p.variations.map((v) => ({ ...v, status: 'publish', image: null })));
  }
  return json(res, 404, { code: 'rest_no_route' });
}

function allVariants() {
  const out = [];
  for (const p of state.shopify.products)
    for (const v of p.variants)
      out.push({
        shop: 'shopify',
        product: p.title,
        sku: v.sku,
        price: v.price,
        stock: v.tracked ? v.inventoryQuantity : null,
        set: (price, qty) => {
          if (price !== undefined) v.price = Number(price).toFixed(2);
          if (qty !== undefined) {
            v.inventoryQuantity = qty;
            v.tracked = true;
          }
        },
      });
  for (const p of state.woo.products) {
    if (p.type === 'simple')
      out.push({
        shop: 'woo',
        product: p.name,
        sku: p.sku,
        price: p.price,
        stock: p.manage_stock ? p.stock_quantity : null,
        set: (price, qty) => {
          if (price !== undefined) {
            p.price = String(price);
            p.sale_price = Number(price) < Number(p.regular_price) ? String(price) : '';
          }
          if (qty !== undefined) {
            p.stock_quantity = qty;
            p.manage_stock = true;
            p.stock_status = qty > 0 ? 'instock' : 'outofstock';
          }
        },
      });
    for (const v of p.variations)
      out.push({
        shop: 'woo',
        product: p.name,
        sku: v.sku,
        price: v.price,
        stock: v.manage_stock === true ? v.stock_quantity : null,
        set: (price, qty) => {
          if (price !== undefined) {
            v.price = String(price);
            v.regular_price = String(price);
          }
          if (qty !== undefined) {
            v.stock_quantity = qty;
            v.manage_stock = true;
            v.stock_status = qty > 0 ? 'instock' : 'outofstock';
          }
        },
      });
  }
  return out;
}

function page() {
  const rows = allVariants()
    .map(
      (
        v,
      ) => `<tr><td>${esc(v.shop)}</td><td>${esc(v.product)}</td><td><code>${esc(v.sku)}</code></td>
      <td>${esc(v.price)}</td><td>${v.stock ?? '—'}</td>
      <td><form method="post" action="/__price"><input type="hidden" name="sku" value="${esc(v.sku)}">
      <input name="price" size="7" placeholder="price"> <button>Set price</button></form></td>
      <td><form method="post" action="/__stock"><input type="hidden" name="sku" value="${esc(v.sku)}">
      <input name="qty" size="4" placeholder="qty"> <button>Set stock</button></form></td></tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Shop stand-in (NOT Shopify or WooCommerce)</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;max-width:1100px}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}code{background:#f3f3f3;padding:1px 4px}
.warn{background:#fff4d6;border:1px solid #f0c36d;padding:10px;border-radius:6px}</style></head><body>
<p class="warn"><b>Stand-in.</b> This is NOT Shopify, WooCommerce or Google. It plays them for local tests of Sellora’s catalog sync. Products live in memory and reset when it restarts.</p>
<h2>Connect from Sellora › Products › Import and sync</h2>
<ul>
<li>Shopify: address <code>${esc(BASE)}/shopify</code>, token <code>${SHOPIFY_TOKEN}</code></li>
<li>WooCommerce: address <code>${esc(BASE)}/woo</code>, key <code>${WOO_KEY}</code>, secret <code>${WOO_SECRET}</code></li>
<li>Sheet link: <code>${esc(BASE)}/sheet.csv</code> (row 6 has a bad price on purpose)</li>
</ul>
<h2>Products</h2><table><tr><th>Shop</th><th>Product</th><th>SKU</th><th>Price</th><th>Stock</th><th></th><th></th></tr>${rows}</table>
<form method="post" action="/__reset" style="margin-top:16px"><button>Reset to the demo products</button></form>
</body></html>`;
}

async function control(req, res, url) {
  const params = new URLSearchParams(url.search);
  if (req.method === 'POST' && /form-urlencoded/.test(req.headers['content-type'] ?? ''))
    for (const [k, v] of new URLSearchParams(await readBody(req))) params.set(k, v);
  const back = () => {
    if (/text\/html/.test(req.headers.accept ?? '')) {
      res.writeHead(303, { location: '/' });
      res.end();
    } else json(res, 200, { ok: true });
  };
  const op = url.pathname;
  if (op === '/__state') return json(res, 200, state);
  if (req.method !== 'POST') return json(res, 405, { error: 'POST' });
  if (op === '/__reset') {
    state = demo();
    return back();
  }
  if (op === '/__price' || op === '/__stock') {
    const v = allVariants().find((x) => x.sku === params.get('sku'));
    if (!v) return json(res, 404, { error: `No SKU ${params.get('sku')}` });
    const n = Number(op === '/__price' ? params.get('price') : params.get('qty'));
    if (!Number.isFinite(n) || n < 0) return json(res, 400, { error: 'Not a number' });
    if (op === '/__price') v.set(n, undefined);
    else v.set(undefined, Math.trunc(n));
    console.log(`${op.slice(3)} ${v.sku} → ${n}`);
    return back();
  }
  if (op === '/__hide') {
    const shop = params.get('shop') === 'woo' ? state.woo : state.shopify;
    const id = params.get('id');
    const before = shop.products.length;
    shop.products = shop.products.filter((p) => String(p.id).split('/').pop() !== id);
    return json(res, before === shop.products.length ? 404 : 200, {
      removed: before - shop.products.length,
    });
  }
  if (op === '/__fail') {
    const shop = params.get('shop') === 'woo' ? state.woo : state.shopify;
    shop.failWith = Number(params.get('status') ?? 0) || 0;
    return json(res, 200, { failWith: shop.failWith });
  }
  return json(res, 404, { error: 'Unknown control' });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  const path = url.pathname;
  (async () => {
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page());
    }
    if (path.startsWith('/__')) return control(req, res, url);
    if (path.startsWith('/img/')) {
      const name = path.slice(5).replace(/\.png$/, '');
      if (!/^[\w-]{1,60}$/.test(name)) return json(res, 404, { error: 'No photo' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(await photo(name));
    }
    if (path === '/sheet.csv') {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="Nakshi catalog (stand-in) - Sheet1.csv"',
      });
      return res.end(state.sheet);
    }
    if (/^\/shopify\/admin\/api\/[\d-]+\/graphql\.json$/.test(path) && req.method === 'POST') {
      const { query, variables } = JSON.parse(await readBody(req));
      if (state.shopify.failWith) return json(res, state.shopify.failWith, { errors: 'Down' });
      if (req.headers['x-shopify-access-token'] !== SHOPIFY_TOKEN)
        return json(res, 401, { errors: '[API] Invalid API key or access token' });
      return json(res, 200, shopify(query, variables ?? {}));
    }
    if (path.startsWith('/woo/wp-json')) return woo(req, res, url);
    json(res, 404, { error: 'not found' });
  })().catch((err) => json(res, 500, { error: String(err) }));
});

server.listen(PORT, () => {
  console.log(`Shop stand-in (NOT Shopify, WooCommerce or Google) on ${BASE}`);
  console.log(`  Shopify      ${BASE}/shopify   token ${SHOPIFY_TOKEN}`);
  console.log(`  WooCommerce  ${BASE}/woo       key ${WOO_KEY} secret ${WOO_SECRET}`);
  console.log(`  Sheet        ${BASE}/sheet.csv`);
});
