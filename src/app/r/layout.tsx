import type { Metadata } from 'next';
import { getStore } from '@/lib/api';
import { fontVars } from '@/lib/fonts';
import { themeAttributes } from '@/lib/theme-style';
import '../globals.css';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Reminder links (`/r/<code>`) have their own root layout: they work while the rest of the
 * shop is closed too (a landing page's cart), and only pass through on the way to the cart.
 */
export default async function RestoreLayout({ children }: { children: React.ReactNode }) {
  const store = await getStore();
  const { attrs, style } = themeAttributes(store?.themeKey, store?.theme ?? null);
  return (
    <html lang={store?.language ?? 'en'} className={fontVars}>
      <body {...attrs} style={style} className="min-h-dvh antialiased">
        {children}
      </body>
    </html>
  );
}
