import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../common/files/csv.js';
import { backoffMinutes } from './catalog-sync.runner.js';
import { SourceError } from './connectors/connector.js';
import { normalizeSheetUrl } from './connectors/sheet.connector.js';
import { normalizeShopifyUrl } from './connectors/shopify.connector.js';
import { normalizeWooUrl } from './connectors/woocommerce.connector.js';
import { headerKey, imageLinks, matchColumns, sheetProducts } from './sheet-columns.js';
import {
  normalizeSourceProduct,
  parseCount,
  parsePrice,
  productHash,
  type SourceProduct,
} from './source-product.js';

const product = (over: Partial<SourceProduct> = {}): SourceProduct => ({
  externalId: 'p1',
  name: 'Jamdani Saree',
  description: '',
  active: true,
  tags: [],
  images: [],
  options: [],
  variants: [
    { externalId: 'v1', optionValues: [], priceMinor: 100_00, trackStock: false, stock: 0 },
  ],
  ...over,
});

const problemOf = (p: SourceProduct) => {
  const r = normalizeSourceProduct(p);
  return r.ok ? null : r.problem.message;
};

describe('parsePrice', () => {
  it.each([
    ['1250', 125_000],
    ['1,250', 125_000],
    ['1,25,000', 12_500_000],
    ['৳1,250', 125_000],
    ['৳ 1,250.50', 125_050],
    ['Tk 1250.00', 125_000],
    ['tk. 99', 9_900],
    ['1250 টাকা', 125_000],
    ['1250/-', 125_000],
    ['১২৫০', 125_000],
    ['১,২৫০.৫', 125_050],
    ['BDT 0', 0],
    ['10.005', 1_001],
    ['10.004', 1_000],
  ])('%s → %s', (text, minor) => {
    expect(parsePrice(text, 'BDT')).toBe(minor);
  });

  it.each(['', 'abc', '12abc', '-5', '1.2.3', '1250,50', '12,5', 'free'])('refuses %j', (text) => {
    expect(parsePrice(text, 'BDT')).toBeNull();
  });

  it('reads numbers from an API and respects the currency precision', () => {
    expect(parsePrice(3200, 'BDT')).toBe(320_000);
    expect(parsePrice(3200.5, 'BDT')).toBe(320_050);
    expect(parsePrice(-1, 'BDT')).toBeNull();
    expect(parsePrice(Number.NaN, 'BDT')).toBeNull();
    expect(parsePrice(null, 'BDT')).toBeNull();
    expect(parsePrice('1500', 'JPY')).toBe(1500);
    expect(parsePrice('2000000000', 'BDT')).toBeNull();
  });
});

describe('parseCount', () => {
  it('reads whole counts, Bangla digits and thousands; negative stock counts as none', () => {
    expect(parseCount('12')).toBe(12);
    expect(parseCount('১২')).toBe(12);
    expect(parseCount('1,200')).toBe(1200);
    expect(parseCount('5.0')).toBe(5);
    expect(parseCount('-3')).toBe(0);
    expect(parseCount(7)).toBe(7);
    expect(parseCount(2.5)).toBeNull();
    expect(parseCount('a few')).toBeNull();
    expect(parseCount('99999999999')).toBe(10_000_000);
  });
});

describe('normalizeSourceProduct', () => {
  it('removes a lone "Default Title" option', () => {
    const r = normalizeSourceProduct(
      product({
        options: [{ name: 'Title', values: ['Default Title'] }],
        variants: [
          {
            externalId: 'v1',
            optionValues: ['Default Title'],
            priceMinor: 500,
            trackStock: false,
            stock: 0,
          },
        ],
      }),
    );
    expect(r.ok && r.product.options).toEqual([]);
    expect(r.ok && r.product.variants[0]!.optionValues).toEqual([]);
  });

  it('matches option values by case and adds values the option list missed', () => {
    const r = normalizeSourceProduct(
      product({
        options: [{ name: 'Size', values: ['M'] }],
        variants: [
          { externalId: 'a', optionValues: ['m'], priceMinor: 500, trackStock: true, stock: 2 },
          { externalId: 'b', optionValues: ['L'], priceMinor: 600, trackStock: true, stock: 1 },
        ],
      }),
    );
    expect(r.ok && r.product.options).toEqual([{ name: 'Size', values: ['M', 'L'] }]);
    expect(r.ok && r.product.variants.map((v) => v.optionValues)).toEqual([['M'], ['L']]);
  });

  it('keeps a compare-at price only when it is higher, and stock only when tracked', () => {
    const r = normalizeSourceProduct(
      product({
        variants: [
          {
            externalId: 'a',
            optionValues: [],
            priceMinor: 500,
            compareAtPriceMinor: 400,
            trackStock: false,
            stock: 9,
          },
        ],
      }),
    );
    expect(r.ok && r.product.variants[0]).toMatchObject({ priceMinor: 500, stock: 0 });
    expect(r.ok && r.product.variants[0]!.compareAtPriceMinor).toBeUndefined();
  });

  it('cleans tags, photos and lengths', () => {
    const r = normalizeSourceProduct(
      product({
        name: `  ${'x'.repeat(250)}  `,
        tags: ['Saree', 'saree', ' ', 'Eid'],
        images: [
          { url: 'https://cdn.example.com/a.jpg' },
          { url: 'https://cdn.example.com/a.jpg' },
          { url: 'javascript:alert(1)' },
          ...Array.from({ length: 10 }, (_, i) => ({ url: `https://cdn.example.com/${i}.jpg` })),
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.product.name).toHaveLength(200);
    expect(r.product.tags).toEqual(['Saree', 'Eid']);
    expect(r.product.images).toHaveLength(8);
    expect(r.product.images[0]).toEqual({ url: 'https://cdn.example.com/a.jpg' });
    expect(r.notes.map((n) => n.message)).toEqual(
      expect.arrayContaining([
        'Skipped a photo with a bad address.',
        'Only the first 8 photos are kept.',
      ]),
    );
  });

  it('refuses what cannot be fixed', () => {
    expect(problemOf(product({ name: '  ' }))).toBe('It has no name.');
    expect(problemOf(product({ variants: [] }))).toBe('It has no price.');
    expect(
      problemOf(
        product({
          options: [{ name: 'Size', values: ['M'] }],
          variants: [
            { externalId: 'a', optionValues: ['M'], priceMinor: 1, trackStock: false, stock: 0 },
            { externalId: 'b', optionValues: ['m'], priceMinor: 2, trackStock: false, stock: 0 },
          ],
        }),
      ),
    ).toBe('Two variants are both M.');
    expect(
      problemOf(
        product({
          options: [{ name: 'Size', values: ['M', 'L'] }],
          variants: [
            {
              externalId: 'a',
              optionValues: ['M'],
              sku: 'X-1',
              priceMinor: 1,
              trackStock: false,
              stock: 0,
            },
            {
              externalId: 'b',
              optionValues: ['L'],
              sku: 'x-1',
              priceMinor: 2,
              trackStock: false,
              stock: 0,
            },
          ],
        }),
      ),
    ).toBe('SKU x-1 is used by two variants.');
    expect(
      problemOf(
        product({
          options: [{ name: 'Size', values: ['M', 'L'] }],
          variants: [
            { externalId: 'a', optionValues: ['M'], priceMinor: 1, trackStock: false, stock: 0 },
            { externalId: 'b', optionValues: [], priceMinor: 1, trackStock: false, stock: 0 },
          ],
        }),
      ),
    ).toBe('A variant does not have a value for every option.');
  });
});

describe('productHash', () => {
  it('changes with what a sync writes, and with stock only when stock is synced', () => {
    const a = product();
    const b = product({ variants: [{ ...a.variants[0]!, stock: 5 }] });
    expect(productHash(a, { syncStock: true })).toBe(productHash(product(), { syncStock: true }));
    expect(productHash(a, { syncStock: true })).not.toBe(productHash(b, { syncStock: true }));
    expect(productHash(a, { syncStock: false })).toBe(productHash(b, { syncStock: false }));
    expect(productHash(a, { syncStock: false })).not.toBe(
      productHash(product({ name: 'Other' }), { syncStock: false }),
    );
    expect(productHash(a, { syncStock: false })).toMatch(/^[\w-]{32}$/);
  });
});

describe('sheet columns', () => {
  it('normalises headers', () => {
    expect(headerKey('Variant Compare-At Price')).toBe('variant compare at price');
    expect(headerKey('  পণ্যের   নাম ')).toBe('পণ্যের নাম');
  });

  it('matches English, Bangla and bracketed headers; reports the rest', () => {
    const c = matchColumns([
      'Product Name',
      'দাম (৳)',
      'Old price',
      'Qty',
      'Colour',
      'Notes',
      'Price',
    ]);
    expect(c.fields).toMatchObject({ name: 0, price: 1, compareAt: 2, stock: 3 });
    expect(c.options).toEqual([{ kind: 'named', name: 'Colour', at: 4 }]);
    // A second price column is not used; the first one wins.
    expect(c.unused).toEqual(['Notes', 'Price']);
  });

  it('reads Shopify-style Option1 Name / Option1 Value pairs instead of named columns', () => {
    const c = matchColumns([
      'Handle',
      'Title',
      'Option1 Name',
      'Option1 Value',
      'Size',
      'Variant Price',
    ]);
    expect(c.options).toEqual([{ kind: 'pair', nameAt: 2, valueAt: 3 }]);
  });

  it('finds photo links in a cell', () => {
    expect(
      imageLinks(
        'https://a.example/1.jpg, https://a.example/2.jpg | ftp://x/3.jpg\nhttp://b.example/4.png',
      ),
    ).toEqual(['https://a.example/1.jpg', 'https://a.example/2.jpg', 'http://b.example/4.png']);
  });
});

describe('sheetProducts', () => {
  const read = (csv: string) => sheetProducts(parseCsv(csv), 'BDT');

  it('groups rows by handle into variants, reads stock words and drops unused options', () => {
    const r = read(
      [
        'Handle,Name,Price,Stock,Size,Colour,Status,Description,Weight',
        'p1,Eid Panjabi,"2,450",5,M,,active,<p>Soft <b>cotton</b></p>,0.5 kg',
        'p1,,2450,out of stock,L,,,,',
        ',Gamchha,120,in stock,,,draft,,200g',
      ].join('\n'),
    );
    expect(r.problems).toEqual([]);
    expect(r.rowsRead).toBe(3);
    const [panjabi, gamchha] = r.products;
    expect(panjabi).toMatchObject({
      externalId: 'handle:p1',
      name: 'Eid Panjabi',
      description: 'Soft cotton',
      active: true,
      options: [{ name: 'Size', values: ['M', 'L'] }],
    });
    expect(panjabi!.variants).toMatchObject([
      { optionValues: ['M'], priceMinor: 245_000, trackStock: true, stock: 5, weightGrams: 500 },
      { optionValues: ['L'], trackStock: true, stock: 0 },
    ]);
    expect(gamchha).toMatchObject({
      externalId: 'name:gamchha',
      active: false,
      options: [],
      variants: [{ optionValues: [], trackStock: false, weightGrams: 200 }],
    });
  });

  it('skips Shopify photo-only rows and collects their photos', () => {
    const r = read(
      [
        'Handle,Title,Variant Price,Image Src',
        'pot,Clay Pot,450,https://cdn.example.com/1.jpg',
        'pot,,,https://cdn.example.com/2.jpg',
      ].join('\n'),
    );
    expect(r.products[0]!.variants).toHaveLength(1);
    expect(r.products[0]!.images.map((i) => i.url)).toEqual([
      'https://cdn.example.com/1.jpg',
      'https://cdn.example.com/2.jpg',
    ]);
  });

  it('names the row and the product of each problem', () => {
    const r = read(['Name,Price,Stock', 'Lungi,abc,1', 'Mat,100,lots', ',50,1'].join('\n'));
    expect(r.products).toEqual([]);
    expect(r.problems).toEqual([
      { ref: 'Row 2 (Lungi)', message: 'The price "abc" is not a number.', skipped: true },
      { ref: 'Row 3 (Mat)', message: 'The stock "lots" is not a whole number.', skipped: true },
      { ref: 'Row 4', message: 'It has no name.', skipped: true },
    ]);
  });

  it('explains a sheet without name or price columns', () => {
    expect(read('Foo,Bar\n1,2').problems[0]!.message).toMatch(/No "Name"/);
    expect(read('Name,Bar\n1,2').problems[0]!.message).toMatch(/No "Price"/);
  });
});

describe('source addresses', () => {
  it('turns a Google Sheet link into its CSV export link, keeping the tab', () => {
    expect(
      normalizeSheetUrl('https://docs.google.com/spreadsheets/d/1AbC-dEf_123/edit#gid=456'),
    ).toBe('https://docs.google.com/spreadsheets/d/1AbC-dEf_123/export?format=csv&gid=456');
    expect(normalizeSheetUrl('https://docs.google.com/spreadsheets/d/1AbC/edit?usp=sharing')).toBe(
      'https://docs.google.com/spreadsheets/d/1AbC/export?format=csv',
    );
    expect(
      normalizeSheetUrl('https://docs.google.com/spreadsheets/d/e/2PACX-1vX/pubhtml?gid=7'),
    ).toBe('https://docs.google.com/spreadsheets/d/e/2PACX-1vX/pub?gid=7&single=true&output=csv');
    expect(normalizeSheetUrl('https://example.com/catalog.csv')).toBe(
      'https://example.com/catalog.csv',
    );
    expect(() => normalizeSheetUrl('https://docs.google.com/document/d/abc')).toThrowError(
      SourceError,
    );
    expect(() => normalizeSheetUrl('my sheet')).toThrowError(/full link/);
  });

  it('accepts a shop name or its .myshopify.com address; other hosts only in tests', () => {
    expect(normalizeShopifyUrl('Nakshi-Ghor', false)).toBe('https://nakshi-ghor.myshopify.com');
    expect(normalizeShopifyUrl('nakshi.myshopify.com/admin/products', false)).toBe(
      'https://nakshi.myshopify.com',
    );
    expect(() => normalizeShopifyUrl('https://nakshighor.com', false)).toThrowError(
      /myshopify\.com/,
    );
    expect(normalizeShopifyUrl('http://127.0.0.1:4090/shopify/admin', true)).toBe(
      'http://127.0.0.1:4090/shopify',
    );
  });

  it('trims a WooCommerce address to the site', () => {
    expect(normalizeWooUrl('shop.example.com/wp-admin/')).toBe('https://shop.example.com');
    expect(normalizeWooUrl('https://example.com/store/wp-json/wc/v3')).toBe(
      'https://example.com/store',
    );
    expect(normalizeWooUrl('https://example.com/shop/')).toBe('https://example.com');
  });
});

describe('backoffMinutes', () => {
  it('doubles the interval with each failure, up to a day', () => {
    expect(backoffMinutes(60, 1)).toBe(60);
    expect(backoffMinutes(60, 2)).toBe(120);
    expect(backoffMinutes(60, 3)).toBe(240);
    expect(backoffMinutes(60, 10)).toBe(1440);
    expect(backoffMinutes(1440, 5)).toBe(1440);
    expect(backoffMinutes(15, 0)).toBe(15);
  });
});
