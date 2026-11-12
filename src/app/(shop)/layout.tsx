import type { Metadata, Viewport } from 'next';
import { AdTagsProvider } from '@/components/ad-tags';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { ShopBeacon } from '@/components/shop-beacon';
import { HoldingPage, NoShopPage } from '@/components/holding-page';
import { ShopProvider } from '@/components/shop-context';
import { headers } from 'next/headers';
import { permanentRedirect } from 'next/navigation';
import { getStore } from '@/lib/api';
import { fontVars } from '@/lib/fonts';
import { dictionary } from '@/lib/i18n';
import { PATH_HEADER, mainAddressRedirect } from '@/lib/main-address';
import { themeAttributes } from '@/lib/theme-style';
import { isOpen } from '@/lib/types';
import '../globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStore();
  if (!store) return { title: 'Sellora', robots: { index: false } };
  if (!isOpen(store)) return { title: store.name, robots: { index: false, follow: false } };
  return {
    metadataBase: new URL(store.url),
    title: { default: store.seo.title, template: `%s · ${store.name}` },
    description: store.seo.description || undefined,
    openGraph: {
      siteName: store.name,
      type: 'website',
      ...(store.theme.logo ? { images: [store.theme.logo.url] } : {}),
    },
    // Previews are for the business and the reviewer only.
    robots:
      store.state === 'preview' ? { index: false, follow: false } : { index: true, follow: true },
    // Search Console's ownership check (ADR 0032): Sellora puts the code here when the
    // business connects Search Console.
    ...(store.seo.googleVerification
      ? { verification: { google: store.seo.googleVerification } }
      : {}),
  };
}

export async function generateViewport(): Promise<Viewport> {
  const store = await getStore();
  return { themeColor: store?.theme?.palette.primary ?? '#ffffff' };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await getStore();
  if (!store)
    return (
      <html lang="en" className={fontVars}>
        <body>
          <NoShopPage language="en" />
        </body>
      </html>
    );

  // An open store lives at one address; the others (its Sellora subdomain, a second domain)
  // send shoppers there, so search engines and shared links agree. Previews stay put.
  if (store.state === 'open') {
    const h = await headers();
    const to = mainAddressRedirect(store.url, h.get('host'), h.get(PATH_HEADER));
    if (to) permanentRedirect(to);
  }

  const t = dictionary(store.language);
  const { attrs, style } = themeAttributes(store.themeKey, store.theme);
  return (
    <html lang={store.language} className={fontVars}>
      <body {...attrs} style={style} className="min-h-dvh antialiased">
        {isOpen(store) ? (
          <ShopProvider
            shop={{
              storeId: store.id,
              name: store.name,
              language: store.language,
              currency: store.currency,
              state: store.state,
              minOrderMinor: store.checkout.minOrderMinor,
              checkoutNote: store.checkout.note,
            }}
          >
            <a
              href="#main"
              className="sr-only z-50 rounded-store bg-primary px-3 py-2 text-on-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
            >
              {t.skip}
            </a>
            {store.state === 'preview' ? (
              <div className="bg-ink px-4 py-2 text-center text-sm font-medium text-white">
                {t.previewBanner}
              </div>
            ) : null}
            {store.theme.announcement ? (
              <div className="bg-accent px-4 py-2 text-center text-sm font-medium text-on-accent">
                {store.theme.announcement}
              </div>
            ) : null}
            <AdTagsProvider
              // Previews load no tags: the business and the reviewer are not shoppers.
              tags={store.state === 'open' ? store.tracking : null}
              endpoint="/api/ad-events"
              currency={store.currency}
              language={store.language}
            >
              <ShopBeacon />
              <Header store={store} />
              <main id="main" className="min-h-[60vh]">
                {children}
              </main>
              <Footer store={store} />
            </AdTagsProvider>
          </ShopProvider>
        ) : (
          <HoldingPage store={store} />
        )}
      </body>
    </html>
  );
}
