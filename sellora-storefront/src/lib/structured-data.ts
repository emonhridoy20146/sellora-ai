import type { OpenStore, ProductDetail } from './types';

/**
 * Structured data (schema.org JSON-LD) for search engines (ADR 0032): products with their
 * offers, breadcrumbs, product questions, and the shop as an organisation and website.
 * Only facts the shop has are written: no made-up ratings, reviews or brands.
 */

type Ld = Record<string, unknown>;

const SCHEMA = 'https://schema.org';

function absolute(base: string, path: string): string {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
}

/** Minor units as schema.org wants prices: a plain number with a dot. */
export function ldPrice(minor: number): string {
  return (minor / 100).toFixed(2);
}

export function productLd(store: Pick<OpenStore, 'url' | 'name'>, p: ProductDetail): Ld {
  const url = absolute(store.url, `/products/${encodeURIComponent(p.slug)}`);
  const description = p.seo?.description || p.description || undefined;
  return {
    '@context': SCHEMA,
    '@type': 'Product',
    name: p.name,
    url,
    ...(description ? { description } : {}),
    image: p.images.map((i) => i.url),
    ...(p.sku ? { sku: p.sku } : {}),
    ...(p.category ? { category: p.category.name } : {}),
    offers: p.variants.map((v) => ({
      '@type': 'Offer',
      ...(p.variants.length > 1 ? { name: v.title } : {}),
      url,
      price: ldPrice(v.priceMinor),
      priceCurrency: p.currency,
      availability: v.available ? `${SCHEMA}/InStock` : `${SCHEMA}/OutOfStock`,
      itemCondition: `${SCHEMA}/NewCondition`,
      seller: { '@type': 'Organization', name: store.name },
    })),
  };
}

export function breadcrumbLd(base: string, items: { name: string; path: string }[]): Ld | null {
  if (items.length < 2) return null;
  return {
    '@context': SCHEMA,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: absolute(base, it.path),
    })),
  };
}

export function faqLd(faq: { question: string; answer: string }[]): Ld | null {
  const items = faq.filter((f) => f.question.trim() && f.answer.trim());
  if (!items.length) return null;
  return {
    '@context': SCHEMA,
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
}

/** The shop as an organisation (logo, contact, social profiles) and as a website. */
export function shopLd(store: OpenStore): Ld[] {
  const url = absolute(store.url, '/');
  const sameAs = (['facebook', 'instagram', 'youtube', 'tiktok'] as const).flatMap((k) => {
    const v = store.social[k];
    return v && /^https?:\/\//.test(v) ? [v] : [];
  });
  const org: Ld = {
    '@context': SCHEMA,
    '@type': 'Organization',
    name: store.name,
    url,
    ...(store.theme.logo ? { logo: store.theme.logo.url } : {}),
    ...(store.contact.email ? { email: store.contact.email } : {}),
    ...(store.contact.phone ? { telephone: store.contact.phone } : {}),
    ...(store.contact.address
      ? { address: { '@type': 'PostalAddress', streetAddress: store.contact.address } }
      : {}),
    ...(sameAs.length ? { sameAs } : {}),
  };
  const site: Ld = {
    '@context': SCHEMA,
    '@type': 'WebSite',
    name: store.name,
    url,
    inLanguage: store.language === 'bn' ? 'bn-BD' : 'en',
    ...(store.seo.description ? { description: store.seo.description } : {}),
  };
  return [org, site];
}

/** JSON for a script tag: "<" escaped so the text cannot close the element. */
export function ldJson(value: Ld | Ld[]): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
