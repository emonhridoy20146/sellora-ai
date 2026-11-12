import { describe, expect, it } from 'vitest';
import { breadcrumbLd, faqLd, ldJson, ldPrice, productLd, shopLd } from './structured-data';
import type { OpenStore, ProductDetail } from './types';

/**
 * Checks the properties Google requires or recommends for each rich result type
 * (developers.google.com/search/docs/appearance/structured-data): Product snippets and
 * merchant listings, breadcrumbs, FAQ and organisation. Returns the problems found.
 */
function problems(ld: Record<string, unknown>): string[] {
  const out: string[] = [];
  const isUrl = (v: unknown) => typeof v === 'string' && /^https?:\/\/[^ ]+$/.test(v);
  if (ld['@context'] !== 'https://schema.org') out.push('@context');
  switch (ld['@type']) {
    case 'Product': {
      if (typeof ld.name !== 'string' || !ld.name) out.push('name');
      if (!Array.isArray(ld.image) || !ld.image.every(isUrl)) out.push('image');
      const offers = ld.offers as Record<string, unknown>[];
      if (!Array.isArray(offers) || !offers.length) out.push('offers');
      for (const o of offers ?? []) {
        if (o['@type'] !== 'Offer') out.push('offer @type');
        if (typeof o.price !== 'string' || !/^\d+(\.\d+)?$/.test(o.price)) out.push('price');
        if (typeof o.priceCurrency !== 'string' || !/^[A-Z]{3}$/.test(o.priceCurrency))
          out.push('priceCurrency');
        if (
          !['https://schema.org/InStock', 'https://schema.org/OutOfStock'].includes(
            o.availability as string,
          )
        )
          out.push('availability');
        if (!isUrl(o.url)) out.push('offer url');
      }
      break;
    }
    case 'BreadcrumbList': {
      const items = ld.itemListElement as Record<string, unknown>[];
      items.forEach((it, i) => {
        if (it.position !== i + 1) out.push(`position ${i}`);
        if (typeof it.name !== 'string' || !it.name) out.push(`name ${i}`);
        if (!isUrl(it.item)) out.push(`item ${i}`);
      });
      break;
    }
    case 'FAQPage': {
      for (const q of ld.mainEntity as Record<string, unknown>[]) {
        if (q['@type'] !== 'Question' || typeof q.name !== 'string') out.push('question');
        const a = q.acceptedAnswer as Record<string, unknown>;
        if (a?.['@type'] !== 'Answer' || typeof a.text !== 'string') out.push('answer');
      }
      break;
    }
    case 'Organization':
    case 'WebSite':
      if (!isUrl(ld.url)) out.push('url');
      if (typeof ld.name !== 'string') out.push('name');
      if (ld.logo !== undefined && !isUrl(ld.logo)) out.push('logo');
      break;
    default:
      out.push(`unknown type ${String(ld['@type'])}`);
  }
  return out;
}

const store = {
  name: 'Nakshi Ghor',
  url: 'https://nakshi.sellora.shop',
  language: 'bn',
  social: {
    facebook: 'https://facebook.com/nakshighor',
    instagram: null,
    youtube: 'not a link',
    tiktok: null,
  },
  contact: { phone: '01712345678', whatsapp: null, email: null, address: 'Mirpur 10, Dhaka' },
  theme: { logo: { url: 'https://files.test/logo.png' } },
  seo: { title: 'Nakshi Ghor', description: 'Handwoven sarees' },
} as unknown as OpenStore;

const product = {
  id: 'p1',
  slug: 'জামদানি-শাড়ি',
  name: 'Jamdani </script> Saree',
  image: null,
  priceMinor: 450_000,
  compareAtPriceMinor: null,
  priceVaries: true,
  inStock: true,
  description: 'Handwoven.',
  images: [{ url: 'https://files.test/a.jpg', alt: 'Red saree' }],
  options: [],
  variants: [
    {
      id: 'v1',
      title: 'Red',
      optionValues: ['Red'],
      priceMinor: 450_000,
      compareAtPriceMinor: null,
      available: true,
      left: null,
    },
    {
      id: 'v2',
      title: 'Blue',
      optionValues: ['Blue'],
      priceMinor: 455_050,
      compareAtPriceMinor: null,
      available: false,
      left: null,
    },
  ],
  category: { name: 'Sarees', slug: 'sarees' },
  currency: 'BDT',
  seo: { title: null, description: 'Dhakai jamdani with cash on delivery.' },
  faq: [
    { question: 'Is it handwoven?', answer: 'Yes.' },
    { question: ' ', answer: 'dropped' },
  ],
  sku: 'JS-01',
} as ProductDetail;

describe('structured data (ADR 0032)', () => {
  it('describes a product with an offer per variant, as Google requires', () => {
    const ld = productLd(store, product);
    expect(problems(ld)).toEqual([]);
    expect(ld).toMatchObject({
      url: 'https://nakshi.sellora.shop/products/%E0%A6%9C%E0%A6%BE%E0%A6%AE%E0%A6%A6%E0%A6%BE%E0%A6%A8%E0%A6%BF-%E0%A6%B6%E0%A6%BE%E0%A6%A1%E0%A6%BC%E0%A6%BF',
      description: 'Dhakai jamdani with cash on delivery.',
      sku: 'JS-01',
      category: 'Sarees',
    });
    const offers = ld.offers as Record<string, unknown>[];
    expect(offers.map((o) => [o.name, o.price, o.availability])).toEqual([
      ['Red', '4500.00', 'https://schema.org/InStock'],
      ['Blue', '4550.50', 'https://schema.org/OutOfStock'],
    ]);
    // No made-up ratings or reviews.
    expect(ld).not.toHaveProperty('aggregateRating');
    expect(ld).not.toHaveProperty('review');
  });

  it('writes prices with a dot and two decimals', () => {
    expect(ldPrice(5)).toBe('0.05');
    expect(ldPrice(120_000)).toBe('1200.00');
  });

  it('lists breadcrumbs with absolute links in order', () => {
    const ld = breadcrumbLd(store.url, [
      { name: 'Home', path: '/' },
      { name: 'Sarees', path: '/products?category=sarees' },
      { name: 'Jamdani', path: '/products/jamdani' },
    ])!;
    expect(problems(ld)).toEqual([]);
    expect((ld.itemListElement as { item: string }[])[1]!.item).toBe(
      'https://nakshi.sellora.shop/products?category=sarees',
    );
    expect(breadcrumbLd(store.url, [{ name: 'Home', path: '/' }])).toBeNull();
  });

  it('turns product questions into an FAQ page, without empty ones', () => {
    const ld = faqLd(product.faq!)!;
    expect(problems(ld)).toEqual([]);
    expect(ld.mainEntity).toHaveLength(1);
    expect(faqLd([])).toBeNull();
  });

  it('describes the shop with its logo, phone and real social links only', () => {
    const [org, site] = shopLd(store);
    expect(problems(org!)).toEqual([]);
    expect(problems(site!)).toEqual([]);
    expect(org).toMatchObject({
      logo: 'https://files.test/logo.png',
      telephone: '01712345678',
      sameAs: ['https://facebook.com/nakshighor'],
    });
    expect(site).toMatchObject({ inLanguage: 'bn-BD', url: 'https://nakshi.sellora.shop/' });
  });

  it('cannot close the script element', () => {
    const json = ldJson(productLd(store, product));
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json).name).toBe('Jamdani </script> Saree');
  });
});
