import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { dictionary } from '@/lib/i18n';
import type { Category, HomeData, OpenStore, Section } from '@/lib/types';
import { cn } from '@/lib/cn';
import { FEATURE_ICONS } from '../icons';
import { ProductGrid } from '../product-card';

type Of<T extends Section['type']> = Extract<Section, { type: T }>;

function SectionTitle({ title, href, label }: { title: string; href?: string; label?: string }) {
  if (!title && !href) return null;
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      {title ? (
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
      ) : (
        <span />
      )}
      {href ? (
        <Link
          href={href}
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {label}
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

function Hero({ section, store }: { section: Of<'hero'>; store: OpenStore }) {
  const withImage = Boolean(section.image);
  return (
    <section
      className={cn(
        'relative overflow-hidden',
        withImage ? 'text-white' : 'hero-plain',
        store.theme.header === 'centered' && 'text-center',
      )}
    >
      {section.image ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={section.image.url}
            alt=""
            className="absolute inset-0 size-full object-cover"
            fetchPriority="high"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-black/65 via-black/35 to-black/10" />
        </>
      ) : null}
      <div
        className={cn(
          'relative mx-auto flex max-w-6xl flex-col gap-4 px-4 py-16 sm:py-24',
          store.theme.header === 'centered' ? 'items-center' : 'items-start',
        )}
      >
        <h1 className="max-w-2xl text-3xl font-bold tracking-tight text-balance sm:text-5xl">
          {section.heading}
        </h1>
        {section.subheading ? (
          <p
            className={cn(
              'max-w-xl text-base sm:text-lg',
              withImage ? 'text-white/90' : 'text-muted',
            )}
          >
            {section.subheading}
          </p>
        ) : null}
        {section.buttonLabel ? (
          <Link
            href="/products"
            className="mt-2 inline-flex h-12 items-center rounded-store bg-primary px-6 font-semibold text-on-primary shadow-sm hover:opacity-90"
          >
            {section.buttonLabel}
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function Categories({
  section,
  categories,
  store,
}: {
  section: Of<'categories'>;
  categories: Category[];
  store: OpenStore;
}) {
  if (!categories.length) return null;
  const t = dictionary(store.language);
  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <SectionTitle title={section.title} />
      <ul className="flex snap-x gap-3 overflow-x-auto pb-2 sm:grid sm:grid-cols-3 sm:overflow-visible lg:grid-cols-4">
        {categories.map((c) => (
          <li key={c.id} className="shrink-0 snap-start">
            <Link
              href={`/products?category=${encodeURIComponent(c.slug)}`}
              className="flex min-w-40 flex-col rounded-store-lg border border-line bg-surface p-4 hover:border-primary"
            >
              <span className="font-medium">{c.name}</span>
              <span className="mt-1 text-xs text-muted">{t.results(String(c.productCount))}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Products({
  section,
  home,
  store,
}: {
  section: Of<'products'>;
  home: HomeData;
  store: OpenStore;
}) {
  const products = home.sections[section.id] ?? [];
  if (!products.length) return null;
  const t = dictionary(store.language);
  const sort = section.source === 'bestsellers' ? '?sort=popular' : '';
  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <SectionTitle title={section.title} href={`/products${sort}`} label={t.viewAll} />
      <ProductGrid products={products} currency={store.currency} language={store.language} />
    </section>
  );
}

function Features({ section }: { section: Of<'features'> }) {
  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <ul className="grid gap-4 rounded-store-lg bg-tint p-6 sm:grid-cols-2 lg:grid-cols-4">
        {section.items.map((item, i) => {
          const Icon = FEATURE_ICONS[item.icon];
          return (
            <li key={i} className="flex gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="font-semibold">{item.title}</p>
                <p className="text-sm text-muted">{item.text}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Banner({ section }: { section: Of<'banner'> }) {
  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <div className="relative overflow-hidden rounded-store-lg bg-primary text-on-primary">
        {section.image ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={section.image.url}
              alt=""
              loading="lazy"
              className="absolute inset-0 size-full object-cover"
            />
            <div className="absolute inset-0 bg-black/45" />
          </>
        ) : null}
        <div
          className={cn(
            'relative flex flex-col items-start gap-3 p-8 sm:p-12',
            section.image && 'text-white',
          )}
        >
          <h2 className="max-w-xl text-2xl font-bold sm:text-3xl">{section.heading}</h2>
          {section.text ? <p className="max-w-xl opacity-90">{section.text}</p> : null}
          {section.buttonLabel ? (
            <Link
              href="/products"
              className="mt-2 inline-flex h-11 items-center rounded-store bg-accent px-5 font-semibold text-on-accent hover:opacity-90"
            >
              {section.buttonLabel}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function TextBlock({ section }: { section: Of<'text'> }) {
  return (
    <section className="mx-auto max-w-3xl px-4 py-10">
      {section.heading ? <h2 className="mb-3 text-2xl font-semibold">{section.heading}</h2> : null}
      <div className="prose-store text-muted">
        {section.body.split(/\n{2,}/).map((p, i) => (
          <p key={i} className="whitespace-pre-line">
            {p}
          </p>
        ))}
      </div>
    </section>
  );
}

/** The home page, section by section, as the business arranged it. */
export function HomeSections({ store, home }: { store: OpenStore; home: HomeData }) {
  return (
    <>
      {store.theme.sections.map((s) => {
        switch (s.type) {
          case 'hero':
            return <Hero key={s.id} section={s} store={store} />;
          case 'categories':
            return <Categories key={s.id} section={s} categories={home.categories} store={store} />;
          case 'products':
            return <Products key={s.id} section={s} home={home} store={store} />;
          case 'features':
            return <Features key={s.id} section={s} />;
          case 'banner':
            return <Banner key={s.id} section={s} />;
          case 'text':
            return <TextBlock key={s.id} section={s} />;
        }
      })}
    </>
  );
}
