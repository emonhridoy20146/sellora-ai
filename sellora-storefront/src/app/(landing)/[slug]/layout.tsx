import type { Viewport } from 'next';
import { getStore } from '@/lib/api';
import { fontVars } from '@/lib/fonts';
import { getLanding } from '@/lib/landing';
import { themeAttributes } from '@/lib/theme-style';
import '../../globals.css';

/**
 * Landing pages have their own root layout: no shop header, menu or cart, and they show
 * even while the rest of the shop is not open. The store's look still applies.
 */
async function look(slug: string) {
  const landing = await getLanding(slug);
  if (landing)
    return {
      language: landing.page.language,
      themeKey: landing.store.themeKey,
      theme: landing.store.theme,
    };
  const store = await getStore();
  return {
    language: store?.language ?? 'en',
    themeKey: store?.themeKey,
    theme: store?.theme ?? null,
  };
}

export async function generateViewport({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Viewport> {
  const { theme } = await look((await params).slug);
  return { themeColor: theme?.palette.primary ?? '#ffffff' };
}

export default async function LandingLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { language, themeKey, theme } = await look((await params).slug);
  const { attrs, style } = themeAttributes(themeKey, theme);
  return (
    <html lang={language} className={fontVars}>
      <body {...attrs} style={style} className="min-h-dvh antialiased">
        {children}
      </body>
    </html>
  );
}
