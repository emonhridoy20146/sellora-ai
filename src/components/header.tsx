import { Search } from 'lucide-react';
import Link from 'next/link';
import { dictionary } from '@/lib/i18n';
import type { OpenStore } from '@/lib/types';
import { cn } from '@/lib/cn';
import { CartButton } from './cart-button';
import { MobileNav } from './mobile-nav';

function Brand({ store, className }: { store: OpenStore; className?: string }) {
  return (
    <Link href="/" className={cn('flex min-w-0 items-center gap-2.5', className)}>
      {store.theme.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={store.theme.logo.url}
          alt=""
          className="size-10 shrink-0 rounded-store object-cover"
        />
      ) : null}
      <span className="truncate font-display text-xl font-semibold tracking-tight sm:text-2xl">
        {store.name}
      </span>
    </Link>
  );
}

export function Header({ store }: { store: OpenStore }) {
  const t = dictionary(store.language);
  const links = [
    { href: '/products', label: t.allProducts },
    { href: '/track', label: t.track },
    ...(store.pages.includes('about') ? [{ href: '/pages/about', label: t.pages.about }] : []),
  ];
  const centered = store.theme.header === 'centered';
  const searchForm = (
    <form action="/products" role="search" className="relative hidden w-full max-w-xs lg:block">
      <label htmlFor="header-search" className="sr-only">
        {t.search}
      </label>
      <input
        id="header-search"
        name="q"
        type="search"
        placeholder={t.searchPlaceholder}
        className="h-10 w-full rounded-store border border-line bg-surface pr-3 pl-9 text-sm text-ink placeholder:text-muted"
      />
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
    </form>
  );
  const nav = (
    <nav aria-label={t.shop} className="hidden md:block">
      <ul className="flex items-center gap-6 text-sm font-medium">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="text-(--header-muted) hover:text-(--header-ink)">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
  const actions = (
    <div className="flex items-center gap-1">
      <Link
        href="/products"
        aria-label={t.search}
        className="inline-flex size-10 items-center justify-center rounded-store hover:bg-black/5 lg:hidden"
      >
        <Search className="size-5" />
      </Link>
      <CartButton />
      <MobileNav links={links} />
    </div>
  );

  return (
    <header className="site-header relative z-30 border-b border-line">
      {centered ? (
        <div className="mx-auto max-w-6xl px-4">
          {/* Centred only where the search box fills the left side; phones keep the brand left. */}
          <div className="flex items-center gap-3 py-4 lg:grid lg:grid-cols-[1fr_auto_1fr]">
            <div className="hidden items-center lg:flex">{searchForm}</div>
            <Brand store={store} className="lg:justify-center lg:text-center" />
            <div className="ml-auto flex justify-end lg:ml-0">{actions}</div>
          </div>
          <div className="hidden justify-center pb-3 md:flex">{nav}</div>
        </div>
      ) : (
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3.5">
          <Brand store={store} />
          <div className="ml-auto flex items-center gap-6">
            {nav}
            {searchForm}
            {actions}
          </div>
        </div>
      )}
      <div className="theme-rule" aria-hidden="true" />
    </header>
  );
}
