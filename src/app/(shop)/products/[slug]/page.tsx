import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import { AddToCart } from '@/components/add-to-cart';
import { Gallery } from '@/components/gallery';
import { JsonLd } from '@/components/json-ld';
import { ProductGrid } from '@/components/product-card';
import { ApiError, apiGet } from '@/lib/api';
import { dictionary } from '@/lib/i18n';
import { openStore } from '@/lib/page-store';
import { breadcrumbLd, faqLd, productLd } from '@/lib/structured-data';
import type { ProductCard, ProductDetail } from '@/lib/types';

type ProductAnswer = { product: ProductDetail; related: ProductCard[] } | { movedTo: string };

const getProduct = cache(async (slug: string) => {
  let res: ProductAnswer;
  try {
    res = await apiGet<ProductAnswer>(`/products/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (err instanceof ApiError && err.problem.status === 404) notFound();
    throw err;
  }
  // An address the product used before: a permanent redirect keeps links and rankings (ADR 0032).
  if ('movedTo' in res) permanentRedirect(`/products/${encodeURIComponent(res.movedTo)}`);
  return res;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  await openStore();
  const { product } = await getProduct(decodeURIComponent((await params).slug));
  const title = product.seo?.title || product.name;
  const description =
    product.seo?.description || product.description.replace(/\s+/g, ' ').slice(0, 160) || undefined;
  return {
    // A search title written for the product is used whole, without the shop's name added.
    title: product.seo?.title ? { absolute: title } : title,
    description,
    alternates: { canonical: `/products/${encodeURIComponent(product.slug)}` },
    openGraph: {
      type: 'website',
      title,
      description,
      url: `/products/${encodeURIComponent(product.slug)}`,
      ...(product.images[0]
        ? { images: [{ url: product.images[0].url, alt: product.images[0].alt }] }
        : {}),
    },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const store = await openStore();
  const t = dictionary(store.language);
  const { product, related } = await getProduct(decodeURIComponent((await params).slug));
  const faq = product.faq ?? [];
  const crumbs = [
    { name: t.home, path: '/' },
    ...(product.category
      ? [
          {
            name: product.category.name,
            path: `/products?category=${encodeURIComponent(product.category.slug)}`,
          },
        ]
      : []),
    { name: product.name, path: `/products/${encodeURIComponent(product.slug)}` },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <JsonLd data={productLd(store, product)} />
      <JsonLd data={breadcrumbLd(store.url, crumbs)} />
      <JsonLd data={faqLd(faq)} />
      <nav aria-label="breadcrumb" className="mb-6 text-sm text-muted">
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>
            <Link href="/" className="hover:text-ink">
              {t.home}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          {product.category ? (
            <>
              <li>
                <Link
                  href={`/products?category=${encodeURIComponent(product.category.slug)}`}
                  className="hover:text-ink"
                >
                  {product.category.name}
                </Link>
              </li>
              <li aria-hidden="true">/</li>
            </>
          ) : null}
          <li aria-current="page" className="line-clamp-1 text-ink">
            {product.name}
          </li>
        </ol>
      </nav>

      <div className="grid gap-8 md:grid-cols-2 md:gap-12">
        <Gallery images={product.images} name={product.name} />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{product.name}</h1>
          <div className="mt-5">
            <AddToCart product={product} />
          </div>
          {product.description ? (
            <section className="mt-10 border-t border-line pt-6">
              <h2 className="mb-3 font-semibold">{t.description}</h2>
              <div className="prose-store text-sm leading-relaxed text-muted">
                {product.description.split(/\n{2,}/).map((p, i) => (
                  <p key={i} className="whitespace-pre-line">
                    {p}
                  </p>
                ))}
              </div>
            </section>
          ) : null}
          {faq.length ? (
            <section className="mt-10 border-t border-line pt-6" aria-labelledby="faq-heading">
              <h2 id="faq-heading" className="mb-3 font-semibold">
                {t.faq}
              </h2>
              <div className="divide-y divide-line">
                {faq.map((f, i) => (
                  <details key={i} className="group py-3">
                    <summary className="cursor-pointer list-none font-medium text-ink marker:hidden">
                      <span
                        className="mr-2 inline-block transition-transform group-open:rotate-90"
                        aria-hidden="true"
                      >
                        ›
                      </span>
                      {f.question}
                    </summary>
                    <p className="mt-2 pl-5 text-sm leading-relaxed whitespace-pre-line text-muted">
                      {f.answer}
                    </p>
                  </details>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {related.length ? (
        <section className="mt-16">
          <h2 className="mb-5 text-xl font-semibold">{t.related}</h2>
          <ProductGrid products={related} currency={store.currency} language={store.language} />
        </section>
      ) : null}
    </div>
  );
}
