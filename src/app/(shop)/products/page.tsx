import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { ProductGrid } from '@/components/product-card';
import { SortSelect } from '@/components/sort-select';
import { apiGet } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dictionary } from '@/lib/i18n';
import { formatNumber } from '@/lib/money';
import { openStore } from '@/lib/page-store';
import type { Category, ProductPage } from '@/lib/types';

const SORTS = ['newest', 'popular', 'price_asc', 'price_desc'] as const;
type Search = { category?: string; q?: string; sort?: string; page?: string };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const store = await openStore();
  const t = dictionary(store.language);
  const q = one((await searchParams).q);
  return { title: q ? `${t.search}: ${q}` : t.allProducts };
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const store = await openStore();
  const t = dictionary(store.language);
  const raw = await searchParams;
  const s: Search = {
    category: one(raw.category)?.slice(0, 80),
    q: one(raw.q)?.trim().slice(0, 80),
    sort: SORTS.find((x) => x === one(raw.sort)) ?? 'newest',
    page: String(Math.min(50, Math.max(1, Number(one(raw.page)) || 1))),
  };
  const query = new URLSearchParams(
    Object.entries({ ...s, limit: '24' }).filter((e): e is [string, string] => Boolean(e[1])),
  );
  const [page, categories] = await Promise.all([
    apiGet<ProductPage>(`/products?${query.toString()}`),
    apiGet<{ items: Category[] }>('/categories'),
  ]);
  const link = (patch: Partial<Search>) => {
    const next = new URLSearchParams(
      Object.entries({ ...s, ...patch }).filter(
        (e): e is [string, string] => Boolean(e[1]) && !(e[0] === 'page' && e[1] === '1'),
      ),
    );
    if (next.get('sort') === 'newest') next.delete('sort');
    const qs = next.toString();
    return qs ? `/products?${qs}` : '/products';
  };
  const title = page.category?.name ?? (s.q ? `${t.search}: “${s.q}”` : t.allProducts);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>

      <form action="/products" role="search" className="mt-5 flex gap-2">
        {s.category ? <input type="hidden" name="category" value={s.category} /> : null}
        <label htmlFor="q" className="sr-only">
          {t.search}
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={s.q ?? ''}
          placeholder={t.searchPlaceholder}
          className="h-11 min-w-0 flex-1 rounded-store border border-line bg-surface px-3 text-ink placeholder:text-muted"
        />
        <button
          type="submit"
          className="h-11 rounded-store bg-primary px-5 font-medium text-on-primary hover:opacity-90"
        >
          {t.search}
        </button>
      </form>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        {categories.items.length ? (
          <nav aria-label={t.categories}>
            <ul className="flex flex-wrap gap-2">
              <li>
                <Link
                  href={link({ category: undefined, page: '1' })}
                  className={cn(
                    'inline-flex h-9 items-center rounded-full border px-4 text-sm',
                    !s.category
                      ? 'border-primary bg-primary text-on-primary'
                      : 'border-line bg-surface hover:border-primary',
                  )}
                >
                  {t.allProducts}
                </Link>
              </li>
              {categories.items.map((c) => (
                <li key={c.id}>
                  <Link
                    href={link({ category: c.slug, page: '1' })}
                    aria-current={s.category === c.slug ? 'page' : undefined}
                    className={cn(
                      'inline-flex h-9 items-center rounded-full border px-4 text-sm',
                      s.category === c.slug
                        ? 'border-primary bg-primary text-on-primary'
                        : 'border-line bg-surface hover:border-primary',
                    )}
                  >
                    {c.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : (
          <span />
        )}
        <Suspense>
          <SortSelect value={s.sort!} />
        </Suspense>
      </div>

      <p className="mt-6 mb-4 text-sm text-muted" aria-live="polite">
        {t.results(formatNumber(page.total, store.language))}
      </p>
      {page.items.length ? (
        <ProductGrid products={page.items} currency={store.currency} language={store.language} />
      ) : (
        <p className="rounded-store-lg border border-dashed border-line p-10 text-center text-muted">
          {s.q ? t.noResults : t.noProducts}
        </p>
      )}

      {page.pageCount > 1 ? (
        <nav className="mt-10 flex items-center justify-center gap-4" aria-label="pagination">
          {page.page > 1 ? (
            <Link
              href={link({ page: String(page.page - 1) })}
              className="rounded-store border border-line bg-surface px-4 py-2 text-sm hover:border-primary"
            >
              {t.previous}
            </Link>
          ) : null}
          <span className="text-sm text-muted">
            {t.pageOf(
              formatNumber(page.page, store.language),
              formatNumber(page.pageCount, store.language),
            )}
          </span>
          {page.page < page.pageCount ? (
            <Link
              href={link({ page: String(page.page + 1) })}
              className="rounded-store border border-line bg-surface px-4 py-2 text-sm hover:border-primary"
            >
              {t.next}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
