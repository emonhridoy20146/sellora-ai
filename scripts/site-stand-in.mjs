/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for a merchant's own website, for trying the website crawl locally (ADR 0024).
 * It is NOT a real shop: a few demo pages kept in memory, with a robots.txt, a sitemap,
 * schema.org Product data on product pages, and delivery, returns and FAQ pages in Bangla and
 * English for the AI to answer from.
 *
 *   node scripts/site-stand-in.mjs     # on http://localhost:4095
 *
 * The API must be allowed to call local addresses, which only development may do:
 *
 *   SYNC_ALLOW_PRIVATE_NETWORK=true    # in sellora-api/.env, then restart the API and the worker
 *
 * Add http://localhost:4095 as "Your website" in Products › Sync. To prove ownership, either
 * put the token on the home page here, or add the TXT record to the DNS stand-in:
 *
 *   curl -X POST 'localhost:4095/__verify?token=<token from the dashboard>'     # meta tag
 *   curl -X PUT localhost:4050/records/_sellora-verify.localhost \
 *     -d '{"TXT":["sellora-verify=<token>"]}'                                  # or DNS
 *
 *   curl localhost:4095/__state                                  # pages, prices, the tag
 *   curl localhost:4095/__log                                    # who asked for what
 *   curl -X POST 'localhost:4095/__price?slug=jamdani-saree&price=2950'   # change a price
 *   curl -X POST 'localhost:4095/__soldout?slug=cotton-panjabi&on=1'      # sold out (0: back)
 *   curl -X POST 'localhost:4095/__hide?slug=handloom-gamcha'             # page answers 404
 *   curl -X POST 'localhost:4095/__reset'                    # back to the demo, empty log
 */
import { createServer } from 'node:http';
import sharp from 'sharp';

const PORT = Number(process.env.PORT ?? 4095);
const BASE = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const SHOP = 'Nakshi Ghor (stand-in site)';

function demo() {
  return {
    token: null,
    products: [
      {
        slug: 'jamdani-saree',
        name: 'Dhakai Jamdani Saree',
        sku: 'WEB-JAM-01',
        price: 3200,
        soldOut: false,
        hidden: false,
        category: 'Sarees',
        text: 'Hand-woven Dhakai jamdani from Rupganj in soft cotton. Six yards with a blouse piece. Each saree takes a weaver about two weeks, so the motif is slightly different on every piece. Dry clean or gentle hand wash in cold water.',
      },
      {
        slug: 'nakshi-kantha',
        name: 'Nakshi Kantha Bedcover',
        sku: 'WEB-KAN-01',
        price: 4500,
        soldOut: false,
        hidden: false,
        category: 'Home',
        text: 'A double-bed nakshi kantha stitched by hand in Jessore. Layers of soft cotton with running-stitch flowers and birds. Size 90 by 108 inches. Wash by hand and dry in the shade.',
      },
      {
        slug: 'cotton-panjabi',
        name: 'Cotton Panjabi',
        sku: 'WEB-PAN-01',
        price: 1850,
        soldOut: false,
        hidden: false,
        category: 'Men',
        text: 'A light cotton panjabi for Eid and everyday wear, with a band collar and wooden buttons. Sizes 38 to 46; see the size guide in the FAQ. Machine wash cold, inside out.',
      },
      {
        slug: 'kids-frock',
        name: 'Kids Cotton Frock',
        sku: 'WEB-FRK-01',
        price: 950,
        soldOut: true,
        hidden: false,
        category: 'Kids',
        text: 'A soft cotton frock for girls aged two to eight, with block-printed flowers and a cloth belt. Comfortable in the summer heat. Machine wash cold with similar colours.',
      },
      {
        slug: 'handloom-gamcha',
        name: 'Handloom Gamcha (set of 2)',
        sku: 'WEB-GAM-02',
        price: 350,
        soldOut: false,
        hidden: false,
        category: 'Home',
        text: 'Two checked handloom gamchas from Kushtia, thin and quick to dry. Use them as towels, scarves or for the kitchen. The colours soften after the first few washes.',
      },
    ],
  };
}

let state = demo();
const log = [];
const photoCache = new Map();

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

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

const live = () => state.products.filter((p) => !p.hidden);

function layout({ title, description, body, head = '', home = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${state.token && home ? `<meta name="sellora-site-verification" content="${esc(state.token)}">` : ''}
${head}
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1d1d1f; background: #fffaf3; }
  header, footer { background: #6b2d1f; color: #fff; padding: 12px 20px; }
  header a, footer a { color: #fff; margin-right: 14px; }
  main { max-width: 760px; margin: 0 auto; padding: 20px; line-height: 1.55; }
  .note { background: #fdf1d6; border: 1px solid #e6c46b; padding: 8px 12px; border-radius: 6px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 14px; }
  .card { background: #fff; border: 1px solid #eadfce; border-radius: 8px; padding: 10px; }
  .card img, .hero img { width: 100%; border-radius: 6px; }
  .price { font-weight: 700; }
  .sold { color: #a11; font-weight: 600; }
</style>
</head>
<body>
<header><nav>
  <a href="/">Home</a><a href="/collections/all">All products</a><a href="/delivery">Delivery</a>
  <a href="/returns">Returns</a><a href="/faq">FAQ</a><a href="/about">About us</a><a href="/cart">Cart</a>
  <a href="/account/login">Log in</a>
</nav></header>
<main>
<p class="note">This is a stand-in website for trying Sellora locally. It is not a real shop.</p>
${body}
</main>
<footer>© ${SHOP} · <a href="/privacy.pdf">Privacy (PDF)</a> · <a href="https://facebook.com/">Facebook</a></footer>
</body>
</html>`;
}

const taka = (n) => `৳${n.toLocaleString('en-US')}`;

function productLd(p) {
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    sku: p.sku,
    description: p.text,
    category: p.category,
    image: `${BASE}/img/${p.slug}.png`,
    offers: {
      '@type': 'Offer',
      price: p.price.toFixed(2),
      priceCurrency: 'BDT',
      availability: `https://schema.org/${p.soldOut ? 'OutOfStock' : 'InStock'}`,
      url: `${BASE}/products/${p.slug}`,
    },
  })}</script>`;
}

const card = (
  p,
) => `<div class="card"><a href="/products/${p.slug}"><img src="/img/${p.slug}.png" alt="${esc(p.name)}">
<strong>${esc(p.name)}</strong></a><br><span class="price">${taka(p.price)}</span>${p.soldOut ? ' <span class="sold">Sold out</span>' : ''}</div>`;

const PAGES = {
  '/': () =>
    layout({
      home: true,
      title: `${SHOP}: handloom from Bangladesh`,
      description:
        'Jamdani sarees, nakshi kantha, panjabis and gamchas, woven and stitched by hand in Bangladesh.',
      body: `<h1>Handloom from Bangladesh</h1>
<p>Nakshi Ghor sells jamdani sarees, nakshi kantha, panjabis and gamchas made by weavers and stitchers we know by name, in Rupganj, Jessore and Kushtia. We deliver all over Bangladesh with cash on delivery.</p>
<h2>New this week</h2>
<div class="grid">${live().map(card).join('')}</div>
<p><a href="/collections/all">See all products</a> · <a href="/collections/all?sort=price">Cheapest first</a></p>`,
    }),
  '/collections/all': () =>
    layout({
      title: 'All products | Nakshi Ghor',
      description: 'Everything we sell, newest first.',
      body: `<h1>All products</h1><p>Every product we have now. Prices are in taka and include VAT. Delivery is added at checkout; see the delivery page for charges.</p>
<div class="grid">${live().map(card).join('')}</div>
<p><a href="/collections/all?sort=price">Sort by price</a> · <a href="/collections/all?page=2">Page 2</a></p>`,
    }),
  '/collections/all?page=2': () =>
    layout({
      title: 'All products, page 2 | Nakshi Ghor',
      description: 'More products.',
      body: '<h1>All products, page 2</h1><p>That is everything for now. New pieces arrive from the weavers every week, so check back soon or ask us on Messenger.</p>',
    }),
  '/delivery': () =>
    layout({
      title: 'Delivery charges and times | Nakshi Ghor',
      description: 'ডেলিভারি চার্জ ও সময়: ঢাকার ভিতরে ৭০ টাকা, ঢাকার বাইরে ১৩০ টাকা।',
      body: `<h1>Delivery</h1>
<h2>ডেলিভারি চার্জ</h2>
<p>ঢাকার ভিতরে ডেলিভারি চার্জ ৭০ টাকা, ঢাকার বাইরে ১৩০ টাকা। ৫,০০০ টাকার বেশি অর্ডারে ডেলিভারি ফ্রি।</p>
<h2>Delivery charges</h2>
<p>Inside Dhaka delivery costs ৳70 and outside Dhaka ৳130. Orders over ৳5,000 are delivered free anywhere in Bangladesh.</p>
<h2>How long it takes</h2>
<p>Inside Dhaka we deliver in 1 to 2 days, outside Dhaka in 3 to 5 days. Orders placed after 5 pm leave the next day. We send the courier's tracking link by SMS.</p>
<h2>Cash on delivery</h2>
<p>You can pay cash when the parcel arrives, or pay first with bKash or Nagad. For cash on delivery outside Dhaka we ask for the delivery charge in advance.</p>`,
    }),
  '/returns': () =>
    layout({
      title: 'Returns and exchanges | Nakshi Ghor',
      description: 'Return or exchange within 7 days.',
      body: `<h1>Returns and exchanges</h1>
<h2>Returns</h2>
<p>You can return an unused product within 7 days of delivery, with its tag. We refund to bKash or Nagad within 3 working days after the parcel reaches us.</p>
<h2>Size exchange</h2>
<p>Panjabis and frocks can be exchanged for another size once, free inside Dhaka. Outside Dhaka the courier charge for the exchange is ৳130.</p>
<h2>ফেরত নীতি</h2>
<p>ডেলিভারির ৭ দিনের মধ্যে ব্যবহার না করা পণ্য ট্যাগসহ ফেরত দিতে পারবেন। টাকা ৩ কার্যদিবসের মধ্যে বিকাশ বা নগদে ফেরত দেওয়া হয়।</p>
<h2>What cannot be returned</h2>
<p>Gamchas and anything washed or altered cannot be returned, unless it arrived damaged. Send us a photo on Messenger within 24 hours if it did.</p>`,
    }),
  '/faq': () =>
    layout({
      title: 'Questions customers ask | Nakshi Ghor',
      description: 'Sizes, washing, colours and orders.',
      body: `<h1>Questions customers ask</h1>
<h2>Panjabi size guide</h2>
<p>Size 38 fits chest 36 to 38 inches, 40 fits 38 to 40, 42 fits 40 to 42, 44 fits 42 to 44 and 46 fits 44 to 46. Length is 42 inches on every size.</p>
<h2>Will the colour run?</h2>
<p>Handloom colours can run in the first wash. Wash it alone in cold water with a little salt the first time.</p>
<h2>Is the photo the real colour?</h2>
<p>Photos are taken in daylight, but screens differ. If you are unsure, ask us on Messenger for a video of the piece.</p>
<h2>Can I order on Messenger?</h2>
<p>Yes. Send us the product name, your size, your phone number and address, and we confirm the order and the delivery charge.</p>`,
    }),
  '/about': () =>
    layout({
      title: 'About us | Nakshi Ghor',
      description: 'Who we are.',
      body: `<h1>About Nakshi Ghor</h1><p>We started in 2019 selling our family's jamdani on Facebook. Today we work with forty weavers and stitchers in Rupganj, Jessore and Kushtia and pay them before the pieces are sold. Our shop in Dhanmondi is open from 11 am to 8 pm, closed on Tuesday.</p>`,
    }),
  '/cart': () =>
    layout({
      title: 'Cart | Nakshi Ghor',
      description: 'Your cart.',
      body: '<h1>Your cart is empty</h1>',
    }),
  '/account/login': () =>
    layout({ title: 'Log in | Nakshi Ghor', description: 'Log in.', body: '<h1>Log in</h1>' }),
};

function productPage(p) {
  return layout({
    title: `${p.name} | Nakshi Ghor`,
    description: p.text.slice(0, 150),
    head: `<link rel="canonical" href="${BASE}/products/${p.slug}">${productLd(p)}`,
    body: `<h1>${esc(p.name)}</h1>
<div class="hero"><img src="/img/${p.slug}.png" alt="${esc(p.name)}"></div>
<p class="price">${taka(p.price)} ${p.soldOut ? '<span class="sold">Sold out</span>' : '<span>In stock</span>'}</p>
<p>${esc(p.text)}</p>
<p>Category: ${esc(p.category)} · SKU ${esc(p.sku)}</p>
<p><a href="/delivery">Delivery charges</a> · <a href="/returns">Returns</a></p>`,
  });
}

function sitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const paths = [
    '/',
    '/collections/all',
    ...live().map((p) => `/products/${p.slug}`),
    '/delivery',
    '/returns',
    '/faq',
    '/about',
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `<url><loc>${BASE}${p}</loc><lastmod>${today}</lastmod></url>`).join('\n')}
</urlset>`;
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  const path = url.pathname;
  const key = url.search && path === '/collections/all' ? `${path}${url.search}` : path;
  if (!path.startsWith('/__')) {
    log.push({
      at: new Date().toISOString(),
      path: `${path}${url.search}`,
      ua: String(req.headers['user-agent'] ?? ''),
    });
    if (log.length > 500) log.shift();
  }
  try {
    if (req.method === 'POST' && path.startsWith('/__')) {
      const slug = url.searchParams.get('slug');
      const p = state.products.find((x) => x.slug === slug);
      if (path === '/__reset') {
        state = demo();
        log.length = 0;
      } else if (path === '/__verify') state.token = url.searchParams.get('token') || null;
      else if (!p)
        return send(res, 404, JSON.stringify({ error: 'unknown slug' }), 'application/json');
      else if (path === '/__price') p.price = Number(url.searchParams.get('price'));
      else if (path === '/__soldout') p.soldOut = url.searchParams.get('on') !== '0';
      else if (path === '/__hide') p.hidden = url.searchParams.get('on') !== '0';
      else return send(res, 404, JSON.stringify({ error: 'unknown control' }), 'application/json');
      return send(res, 200, JSON.stringify(state, null, 2), 'application/json');
    }
    if (path === '/__state')
      return send(res, 200, JSON.stringify(state, null, 2), 'application/json');
    if (path === '/__log') return send(res, 200, JSON.stringify(log, null, 2), 'application/json');
    if (path === '/robots.txt')
      return send(
        res,
        200,
        `User-agent: *\nDisallow: /cart\nDisallow: /account/\n\nSitemap: ${BASE}/sitemap.xml\n`,
        'text/plain',
      );
    if (path === '/sitemap.xml') return send(res, 200, sitemap(), 'application/xml');
    if (path.startsWith('/img/')) return send(res, 200, await photo(path.slice(5)), 'image/png');
    if (path.startsWith('/products/')) {
      const p = state.products.find((x) => x.slug === path.slice('/products/'.length));
      if (!p || p.hidden)
        return send(
          res,
          404,
          layout({ title: 'Not found', description: '', body: '<h1>Not found</h1>' }),
        );
      return send(res, 200, productPage(p));
    }
    const page = PAGES[key] ?? PAGES[path];
    if (page) return send(res, 200, page());
    return send(
      res,
      404,
      layout({ title: 'Not found', description: '', body: '<h1>Not found</h1>' }),
    );
  } catch (err) {
    console.error(err);
    return send(res, 500, 'stand-in error', 'text/plain');
  }
});

server.listen(PORT, () => console.log(`Website stand-in (not a real shop) on ${BASE}`));
