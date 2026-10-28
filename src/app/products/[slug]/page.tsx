import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { AddToCart } from '@/components/add-to-cart';
import { Gallery } from '@/components/gallery';
import { ProductGrid } from '@/components/product-card';
import { ApiError, apiGet } from '@/lib/api';
import { dictionary } from '@/lib/i18n';
import { openStore } from '@/lib/page-store';
import type { ProductCard, ProductDetail } from '@/lib/types';

const getProduct = cache(async (slug: string) => {
  try {
    return await apiGet<{ product: ProductDetail; related: ProductCard[] }>(
      `/products/${encodeURIComponent(slug)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.problem.status === 404) notFound();
    throw err;
  }
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  await openStore();
  const { product } = await getProduct(decodeURIComponent((await params).slug));
  const description = product.description.slice(0, 160) || undefined;
  return {
    title: product.name,
    description,
    alternates: { canonical: `/products/${encodeURIComponent(product.slug)}` },
    openGraph: {
      title: product.name,
      description,
      ...(product.images[0] ? { images: [product.images[0].url] } : {}),
    },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const store = await openStore();
  const t = dictionary(store.language);
  const { product, related } = await getProduct(decodeURIComponent((await params).slug));
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description || undefined,
    image: product.images.map((i) => i.url),
    offers: product.variants.map((v) => ({
      '@type': 'Offer',
      name: v.title,
      price: (v.priceMinor / 100).toFixed(2),
      priceCurrency: product.currency,
      availability: v.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    })),
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <script
        type="application/ld+json"
        // JSON.stringify output with "<" escaped cannot close the script element.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
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
