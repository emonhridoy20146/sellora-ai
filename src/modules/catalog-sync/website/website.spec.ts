import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { passages, searchTerms } from '../../knowledge/website-pages.js';
import { countWords, parseHtmlPage } from './html-page.js';
import { checkOwnership, ownershipInstructions, verifyNames } from './ownership.js';
import { availabilityOf, pageProducts, parseJsonLd } from './product-data.js';
import { isAllowed, parseRobots } from './robots.js';
import { parseSitemap, sitemapText } from './sitemap.js';
import {
  crawlableUrl,
  normalizeSiteUrl,
  pageKey,
  registrableDomain,
  sameSite,
} from './site-url.js';

describe('robots.txt (RFC 9309)', () => {
  const text = [
    '# comment',
    'User-agent: *',
    'Disallow: /private/',
    'Allow: /private/open$',
    'Disallow: /*.pdf$',
    'Crawl-delay: 2',
    '',
    'User-agent: SelloraBot',
    'User-agent: OtherBot',
    'Disallow: /no-sellora/',
    'Allow: /no-sellora/but-this',
    '',
    'Sitemap: https://shop.example/sitemap.xml',
  ].join('\n');

  it('uses the group for SelloraBot when there is one, and collects sitemaps', () => {
    const r = parseRobots(text, 'SelloraBot');
    expect(r.rules).toEqual([
      { allow: false, pattern: '/no-sellora/' },
      { allow: true, pattern: '/no-sellora/but-this' },
    ]);
    expect(r.sitemaps).toEqual(['https://shop.example/sitemap.xml']);
    expect(r.crawlDelay).toBeNull();
    expect(isAllowed(r, '/private/x')).toBe(true);
    expect(isAllowed(r, '/no-sellora/page')).toBe(false);
    expect(isAllowed(r, '/no-sellora/but-this/one')).toBe(true);
  });

  it('falls back to *: longest match wins, Allow wins ties, * and $ patterns', () => {
    const r = parseRobots(text, 'SomeoneElse');
    expect(r.crawlDelay).toBe(2);
    expect(isAllowed(r, '/')).toBe(true);
    expect(isAllowed(r, '/private/a')).toBe(false);
    expect(isAllowed(r, '/private/open')).toBe(true);
    expect(isAllowed(r, '/private/open/more')).toBe(false);
    expect(isAllowed(r, '/files/a.pdf')).toBe(false);
    expect(isAllowed(r, '/files/a.pdf?x=1')).toBe(true);
    const tie = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a', 'x');
    expect(isAllowed(tie, '/a')).toBe(true);
  });

  it('allows everything with an empty Disallow, no file rules, and always allows /robots.txt', () => {
    expect(isAllowed(parseRobots('User-agent: *\nDisallow:', 'x'), '/anything')).toBe(true);
    const none = parseRobots('User-agent: *\nDisallow: /', 'x');
    expect(isAllowed(none, '/')).toBe(false);
    expect(isAllowed(none, '/robots.txt')).toBe(true);
  });

  it('matches non-ASCII paths written either way', () => {
    const r = parseRobots('User-agent: *\nDisallow: /পণ্য/', 'x');
    expect(isAllowed(r, '/%E0%A6%AA%E0%A6%A3%E0%A7%8D%E0%A6%AF/a')).toBe(false);
  });
});

describe('sitemaps', () => {
  it('reads urlsets with lastmod, indexes, CDATA, entities and .gz files', () => {
    const xml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <!-- <url><loc>https://x/commented</loc></url> -->
        <url><loc>https://shop.example/a?x=1&amp;y=2</loc><lastmod>2026-11-01</lastmod></url>
        <url><loc><![CDATA[https://shop.example/b]]></loc></url>
      </urlset>`;
    expect(parseSitemap(xml)).toEqual({
      kind: 'urlset',
      entries: [
        { loc: 'https://shop.example/a?x=1&y=2', lastmod: Date.parse('2026-11-01') },
        { loc: 'https://shop.example/b', lastmod: null },
      ],
    });
    const index =
      '<sitemapindex><sitemap><loc>https://shop.example/s1.xml</loc></sitemap></sitemapindex>';
    expect(parseSitemap(index)?.kind).toBe('index');
    expect(parseSitemap(sitemapText(gzipSync(Buffer.from(xml))))?.entries).toHaveLength(2);
    expect(parseSitemap('<html>not a sitemap</html>')).toBeNull();
  });
});

describe('site addresses', () => {
  const site = new URL('https://shop.example/');

  it('stores the site as its origin', () => {
    expect(normalizeSiteUrl('Shop.Example/bn/home?x=1#top')).toBe('https://shop.example/');
    expect(normalizeSiteUrl('http://127.0.0.1:4100/a')).toBe('http://127.0.0.1:4100/');
  });

  it('follows pages of the site only, moved onto its own origin, without tracking parameters', () => {
    const at = (href: string) =>
      crawlableUrl(href, 'https://shop.example/x/', site)?.toString() ?? null;
    expect(at('/p/saree?utm_source=fb&fbclid=1')).toBe('https://shop.example/p/saree');
    expect(at('http://www.shop.example/about#team')).toBe('https://shop.example/about');
    expect(at('relative')).toBe('https://shop.example/x/relative');
    expect(at('https://other.example/a')).toBeNull();
    expect(at('mailto:a@b.c')).toBeNull();
    expect(at('/cart/')).toBeNull();
    expect(at('/wp-admin/edit.php')).toBeNull();
    expect(at('/photo.JPG')).toBeNull();
    expect(at('/shop?orderby=price')).toBeNull();
    expect(at('/shop?a=1&b=2')).toBeNull();
    expect(at('/?page_id=12')).toBe('https://shop.example/?page_id=12');
  });

  it('keys pages by path and query, and knows www and registrable domains', () => {
    expect(pageKey(new URL('https://shop.example/a/b?c=1'))).toBe('/a/b?c=1');
    expect(sameSite('www.shop.example', 'shop.example')).toBe(true);
    expect(registrableDomain('www.nakshi.com.bd')).toBe('nakshi.com.bd');
    expect(verifyNames('www.nakshi.com.bd')).toEqual(['www.nakshi.com.bd', 'nakshi.com.bd']);
  });
});

describe('HTML pages', () => {
  const html = `<!doctype html><html lang="bn"><head>
    <title>Delivery &amp; returns | Nakshi</title>
    <meta name="description" content="How we deliver">
    <meta name="sellora-site-verification" content="tok123">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="/delivery">
    <script type="application/ld+json">{"@type":"WebPage"}</script>
    <script src="/app.js"></script>
    <style>.x{}</style>
  </head><body>
    <header><nav><a href="/">Home</a> <a href="/shop">Shop</a></nav></header>
    <main>
      <h1>Delivery</h1>
      <p>Inside Dhaka: 1-2 days, ৳80. Outside Dhaka: 3-5 days, ৳150. Cash on delivery everywhere in Bangladesh, and you can check the parcel first.</p>
      <ul><li>Returns within 7 days</li><li>Exchange for size</li></ul>
      <div hidden>secret</div>
      <a href="/size-guide">Size guide</a> <a rel="nofollow" href="/login">Log in</a>
    </main>
    <footer>© Nakshi</footer>
  </body></html>`;

  it('reads title, description, canonical, links, JSON-LD, the token and the main text', () => {
    const p = parseHtmlPage(html);
    expect(p.title).toBe('Delivery & returns | Nakshi');
    expect(p.description).toBe('How we deliver');
    expect(p.lang).toBe('bn');
    expect(p.canonical).toBe('/delivery');
    expect(p.verification).toEqual(['tok123']);
    expect(p.noindex).toBe(false);
    expect(p.links).toEqual(['/', '/shop', '/size-guide']);
    expect(p.jsonLd).toEqual(['{"@type":"WebPage"}']);
    expect(p.scripts).toBe(1);
    expect(p.text.split('\n')).toEqual([
      'Delivery',
      'Inside Dhaka: 1-2 days, ৳80. Outside Dhaka: 3-5 days, ৳150. Cash on delivery everywhere in Bangladesh, and you can check the parcel first.',
      '• Returns within 7 days',
      '• Exchange for size',
      'Size guide Log in',
    ]);
    expect(p.text).not.toMatch(/secret|Nakshi$|Home Shop/);
  });

  it('leaves out header, navigation and footer when there is no <main>', () => {
    const p = parseHtmlPage(
      '<body><nav>Menu words</nav><div><p>Our story began in Rajshahi with three looms.</p></div><footer>Copyright</footer></body>',
    );
    expect(p.text).toBe('Our story began in Rajshahi with three looms.');
  });

  it('honours noindex and nofollow from the meta tag or the X-Robots-Tag header', () => {
    expect(parseHtmlPage('<meta name="robots" content="noindex,nofollow">')).toMatchObject({
      noindex: true,
      nofollow: true,
    });
    expect(parseHtmlPage('<p>x</p>', 'none').noindex).toBe(true);
    expect(parseHtmlPage('<p>x</p>', 'googlebot: noindex').noindex).toBe(false);
    expect(parseHtmlPage('<p>x</p>', 'sellorabot: noindex').noindex).toBe(true);
  });

  it('counts Bangla and English words', () => {
    expect(countWords('শাড়ি আর পাঞ্জাবি — sarees and panjabis!')).toBe(6);
  });
});

describe('product data on a page', () => {
  const ctx = { pageUrl: 'https://shop.example/p/saree', externalId: '/p/saree', currency: 'BDT' };
  const page = (ld: unknown, extra = '') =>
    parseHtmlPage(
      `<head><script type="application/ld+json">${JSON.stringify(ld)}</script>${extra}</head><body></body>`,
    );

  it('reads a JSON-LD product with an offer, old price, availability, photos, SKU and barcode', () => {
    const r = pageProducts(
      page({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Jamdani Saree',
        description: '<p>Hand-woven <b>Dhakai</b> jamdani.</p>',
        sku: 'JAM-1',
        gtin13: '1234567890123',
        brand: { '@type': 'Brand', name: 'Nakshi' },
        category: 'Clothing > Sarees',
        image: ['/img/saree.jpg', { '@type': 'ImageObject', url: 'https://cdn.example/s2.jpg' }],
        offers: {
          '@type': 'Offer',
          price: '3200.00',
          priceCurrency: 'BDT',
          availability: 'https://schema.org/InStock',
          priceSpecification: [
            {
              '@type': 'UnitPriceSpecification',
              priceType: 'https://schema.org/StrikethroughPrice',
              price: 3800,
            },
          ],
        },
      }),
      ctx,
    );
    expect(r.hasProductData).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.product).toEqual({
      externalId: '/p/saree',
      name: 'Jamdani Saree',
      description: 'Hand-woven Dhakai jamdani.',
      tags: ['Nakshi'],
      category: 'Sarees',
      images: [
        { url: 'https://shop.example/img/saree.jpg' },
        { url: 'https://cdn.example/s2.jpg' },
      ],
      active: true,
      options: [],
      variants: [
        {
          externalId: 'JAM-1',
          optionValues: [],
          sku: 'JAM-1',
          barcode: '1234567890123',
          priceMinor: 320000,
          compareAtPriceMinor: 380000,
          trackStock: false,
          stock: 0,
        },
      ],
    });
  });

  it('reads a ProductGroup inside @graph with sizes, and sold-out variants as a counted 0', () => {
    const r = pageProducts(
      page({
        '@graph': [
          { '@type': 'WebSite', name: 'Nakshi' },
          {
            '@type': 'ProductGroup',
            name: 'Eid Panjabi',
            variesBy: ['https://schema.org/size'],
            hasVariant: [
              {
                '@type': 'Product',
                sku: 'PJ-M',
                size: 'M',
                offers: { price: 1800, priceCurrency: 'BDT', availability: 'InStock' },
              },
              {
                '@type': 'Product',
                sku: 'PJ-L',
                size: 'L',
                offers: { price: 1900, availability: 'https://schema.org/OutOfStock' },
              },
            ],
          },
        ],
      }),
      ctx,
    );
    expect(r.product?.options).toEqual([{ name: 'Size', values: ['M', 'L'] }]);
    expect(r.product?.variants.map((v) => [v.sku, v.priceMinor, v.trackStock, v.stock])).toEqual([
      ['PJ-M', 180000, false, 0],
      ['PJ-L', 190000, true, 0],
    ]);
  });

  it('turns several named offers into one "Option" choice each', () => {
    const r = pageProducts(
      page({
        '@type': 'Product',
        name: 'Mustard Oil',
        offers: [
          { '@type': 'Offer', name: '500 ml', price: 220, sku: 'OIL-500' },
          { '@type': 'Offer', name: '1 litre', price: 420, sku: 'OIL-1000' },
        ],
      }),
      ctx,
    );
    expect(r.product?.options).toEqual([{ name: 'Option', values: ['500 ml', '1 litre'] }]);
    expect(r.product?.variants.map((v) => v.priceMinor)).toEqual([22000, 42000]);
  });

  it('refuses a price range without each choice, another currency, and a missing price', () => {
    const range = pageProducts(
      page({
        '@type': 'Product',
        name: 'Lungi',
        offers: { '@type': 'AggregateOffer', lowPrice: 450, highPrice: 650 },
      }),
      ctx,
    );
    expect(range.product).toBeNull();
    expect(range.hasProductData).toBe(true);
    expect(range.problems[0]).toMatchObject({ ref: 'Lungi', skipped: true });
    expect(range.problems[0]!.message).toMatch(/price range \(450–650\)/);
    const usd = pageProducts(
      page({ '@type': 'Product', name: 'Pot', offers: { price: 12, priceCurrency: 'USD' } }),
      ctx,
    );
    expect(usd.problems[0]!.message).toMatch(/priced in USD/);
    const none = pageProducts(page({ '@type': 'Product', name: 'Mat' }), ctx);
    expect(none.problems[0]!.message).toBe('The page has no price for it.');
  });

  it('treats a page with several products as a list, and a product with another url as elsewhere', () => {
    const list = pageProducts(
      page([
        { '@type': 'Product', name: 'A', offers: { price: 1 } },
        { '@type': 'Product', name: 'B', offers: { price: 2 } },
      ]),
      ctx,
    );
    expect(list).toEqual({ product: null, problems: [], hasProductData: false });
    const elsewhere = pageProducts(
      page({
        '@type': 'Product',
        name: 'A',
        url: 'https://shop.example/p/other',
        offers: { price: 1 },
      }),
      ctx,
    );
    expect(elsewhere.hasProductData).toBe(false);
    const same = pageProducts(
      page({
        '@type': 'Product',
        name: 'A',
        url: 'https://shop.example/p/saree/',
        offers: { price: 1 },
      }),
      ctx,
    );
    expect(same.product?.name).toBe('A');
  });

  it('falls back to OpenGraph product tags, and marks discontinued products inactive', () => {
    const og = parseHtmlPage(`<head>
      <meta property="og:type" content="product"><meta property="og:title" content="Clay Pot">
      <meta property="og:image" content="/pot.png"><meta property="product:price:amount" content="৳ 450">
      <meta property="product:price:currency" content="BDT"><meta property="product:availability" content="out of stock">
      <meta property="product:retailer_item_id" content="POT-1"></head>`);
    const r = pageProducts(og, ctx);
    expect(r.product).toMatchObject({
      name: 'Clay Pot',
      images: [{ url: 'https://shop.example/pot.png' }],
      variants: [{ sku: 'POT-1', priceMinor: 45000, trackStock: true, stock: 0 }],
    });
    const gone = pageProducts(
      page({ '@type': 'Product', name: 'Old', offers: { price: 1, availability: 'Discontinued' } }),
      ctx,
    );
    expect(gone.product?.active).toBe(false);
  });

  it('reads JSON-LD with raw new lines and trailing commas, and knows availability words', () => {
    expect(parseJsonLd('{"@type":"Product","name":"A\nB",}')).toEqual([
      { '@type': 'Product', name: 'A B' },
    ]);
    expect(parseJsonLd('not json')).toEqual([]);
    expect(availabilityOf('https://schema.org/SoldOut')).toBe('sold_out');
    expect(availabilityOf('PreOrder')).toBe('in_stock');
    expect(availabilityOf('weird')).toBeNull();
  });
});

describe('ownership proof', () => {
  const home = (tag: string) => parseHtmlPage(`<head>${tag}</head>`);
  const dns =
    (records: Record<string, string[]>, unreachable = false) =>
    (domain: string) =>
      Promise.resolve({ txt: records[domain] ?? [], unreachable });

  it('accepts the meta tag or the TXT record on the host or registrable domain', async () => {
    const tag = '<meta name="sellora-site-verification" content="abc">';
    expect(
      await checkOwnership({ host: 'www.shop.com.bd', token: 'abc', home: home(tag) }),
    ).toEqual({
      ok: true,
      method: 'meta',
    });
    expect(
      await checkOwnership({
        host: 'www.shop.com.bd',
        token: 'abc',
        home: home(''),
        lookup: dns({ 'shop.com.bd': ['sellora-verify=abc'] }),
      }),
    ).toEqual({ ok: true, method: 'dns' });
  });

  it('is definite only when the home page was read and DNS answered', async () => {
    const lost = await checkOwnership({
      host: 'shop.com',
      token: 'abc',
      home: home(''),
      lookup: dns({}),
    });
    expect(lost).toMatchObject({ ok: false, definite: true });
    const down = await checkOwnership({
      host: 'shop.com',
      token: 'abc',
      home: null,
      lookup: dns({}),
    });
    expect(down).toMatchObject({ ok: false, definite: false });
    const noDns = await checkOwnership({
      host: 'shop.com',
      token: 'abc',
      home: home(''),
      lookup: dns({}, true),
    });
    expect(noDns).toMatchObject({ ok: false, definite: false });
    const wrong = await checkOwnership({
      host: 'shop.com',
      token: 'abc',
      home: home('<meta name="sellora-site-verification" content="old">'),
      lookup: dns({}),
    });
    expect(wrong.ok === false && wrong.message).toMatch(/with another code/);
  });

  it('tells the merchant exactly what to add', () => {
    expect(ownershipInstructions('www.shop.com.bd', 'abc')).toEqual({
      dnsName: '_sellora-verify.shop.com.bd',
      dnsValue: 'sellora-verify=abc',
      metaTag: '<meta name="sellora-site-verification" content="abc">',
    });
  });
});

describe('page search passages', () => {
  const text = [
    'Delivery',
    'Inside Dhaka: 1-2 days, ৳80.',
    'Outside Dhaka: 3-5 days, ৳150.',
    'Returns',
    'Return within 7 days if unused.',
    'ফেরত: ৭ দিনের মধ্যে',
  ].join('\n');

  it('splits a question into words, Bangla included', () => {
    expect(searchTerms('Delivery charge outside Dhaka? ফেরত')).toEqual([
      'delivery',
      'charge',
      'outside',
      'dhaka',
      'ফেরত',
    ]);
  });

  it('returns the matching lines in page order, with the line after a heading', () => {
    expect(passages(text, ['outside'])).toBe('…\nOutside Dhaka: 3-5 days, ৳150.\n…');
    expect(passages(text, ['returns'])).toBe('…\nReturns\nReturn within 7 days if unused.\n…');
    expect(passages(text, ['ফেরত'])).toBe('…\nফেরত: ৭ দিনের মধ্যে');
    expect(passages(text, ['nothing'], 40)).toBe('Delivery\nInside Dhaka: 1-2 days, ৳80.\n…');
  });
});
