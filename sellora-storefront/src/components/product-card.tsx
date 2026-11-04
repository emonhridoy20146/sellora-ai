import Link from 'next/link';
import { dictionary } from '@/lib/i18n';
import type { Language, ProductCard as Card } from '@/lib/types';
import { Price } from './price';

export function ProductCard({
  product,
  currency,
  language,
}: {
  product: Card;
  currency: string;
  language: Language;
}) {
  const t = dictionary(language);
  const onSale =
    product.compareAtPriceMinor !== null && product.compareAtPriceMinor > product.priceMinor;
  return (
    <Link
      href={`/products/${encodeURIComponent(product.slug)}`}
      className="product-card group flex flex-col overflow-hidden"
    >
      <div className="relative aspect-square overflow-hidden rounded-store bg-tint">
        {product.image ? (
          // Images come from the business's storage, on whatever host the platform uses.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.image.url}
            alt={product.image.alt}
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex size-full items-center justify-center p-4 text-center font-display text-lg text-muted">
            {product.name}
          </div>
        )}
        {!product.inStock ? (
          <span className="absolute top-2 left-2 rounded-store bg-ink/80 px-2 py-0.5 text-xs font-medium text-white">
            {t.outOfStock}
          </span>
        ) : onSale ? (
          <span className="absolute top-2 left-2 rounded-store bg-accent px-2 py-0.5 text-xs font-semibold text-on-accent">
            {t.sale}
          </span>
        ) : null}
      </div>
      <div className="card-body flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-sm font-medium text-ink sm:text-base">{product.name}</h3>
        <Price
          minor={product.priceMinor}
          compareAtMinor={product.compareAtPriceMinor}
          currency={currency}
          language={language}
          {...(product.priceVaries ? { from: t.from } : {})}
          className="mt-auto text-sm sm:text-base"
        />
      </div>
    </Link>
  );
}

export function ProductGrid({
  products,
  currency,
  language,
}: {
  products: Card[];
  currency: string;
  language: Language;
}) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3 lg:grid-cols-4">
      {products.map((p) => (
        <li key={p.id} className="flex">
          <ProductCard product={p} currency={currency} language={language} />
        </li>
      ))}
    </ul>
  );
}
