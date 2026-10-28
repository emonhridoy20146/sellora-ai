import type { Metadata, Viewport } from 'next';
import {
  Hind_Siliguri,
  Inter,
  Noto_Sans_Bengali,
  Noto_Serif_Bengali,
  Nunito,
  Playfair_Display,
} from 'next/font/google';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { HoldingPage, NoShopPage } from '@/components/holding-page';
import { ShopProvider } from '@/components/shop-context';
import { getStore } from '@/lib/api';
import { dictionary } from '@/lib/i18n';
import { themeAttributes } from '@/lib/theme-style';
import { isOpen } from '@/lib/types';
import './globals.css';

// Every store picks one of three type pairs; a font file downloads only when a page uses it.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
  preload: false,
});
const bnSans = Noto_Sans_Bengali({
  subsets: ['bengali'],
  variable: '--font-bn-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
  preload: false,
});
const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-playfair',
  display: 'swap',
  preload: false,
});
const bnSerif = Noto_Serif_Bengali({
  subsets: ['bengali'],
  variable: '--font-bn-serif',
  display: 'swap',
  weight: ['400', '600', '700'],
  preload: false,
});
const nunito = Nunito({
  subsets: ['latin'],
  variable: '--font-nunito',
  display: 'swap',
  preload: false,
});
const hind = Hind_Siliguri({
  subsets: ['bengali'],
  variable: '--font-bn-hind',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
  preload: false,
});
const fontVars = [inter, bnSans, playfair, bnSerif, nunito, hind].map((f) => f.variable).join(' ');

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
            <Header store={store} />
            <main id="main" className="min-h-[60vh]">
              {children}
            </main>
            <Footer store={store} />
          </ShopProvider>
        ) : (
          <HoldingPage store={store} />
        )}
      </body>
    </html>
  );
}
