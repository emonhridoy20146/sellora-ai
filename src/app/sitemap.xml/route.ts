import { ApiError, apiGet, contextFrom, getStore } from '@/lib/api';
import { landingSitemap } from '@/lib/landing-sitemap';
import type { NextRequest } from 'next/server';

interface SitemapData {
  products: { slug: string; updatedAt: string }[];
  categories: string[];
  pages: string[];
  updatedAt: string;
}

const escape = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );

/**
 * Pages of an open store for search engines, with its live landing pages. A store that is
 * not open lists only its landing pages (they can be live on their own); previews list none.
 */
export async function GET(req: NextRequest) {
  const store = await getStore();
  if (!store || store.state === 'preview') return new Response('Not found', { status: 404 });
  const ctx = contextFrom(req.headers, undefined);
  const base = store.url.replace(/\/$/, '');
  const landing = (await landingSitemap(ctx)).map((p) => ({
    loc: `${base}/${encodeURIComponent(p.slug)}`,
    lastmod: p.updatedAt,
  }));
  let urls: { loc: string; lastmod?: string }[] = landing;
  if (store.state === 'open') {
    let data: SitemapData;
    try {
      data = await apiGet<SitemapData>('/sitemap', ctx);
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 404)
        return new Response('Not found', { status: 404 });
      throw err;
    }
    urls = [
      { loc: `${base}/`, lastmod: data.updatedAt },
      { loc: `${base}/products`, lastmod: data.updatedAt },
      ...data.categories.map((c) => ({
        loc: `${base}/products?category=${encodeURIComponent(c)}`,
      })),
      ...data.products.map((p) => ({
        loc: `${base}/products/${encodeURIComponent(p.slug)}`,
        lastmod: p.updatedAt,
      })),
      ...data.pages.map((p) => ({ loc: `${base}/pages/${p}` })),
      ...landing,
    ];
  }
  if (!urls.length) return new Response('Not found', { status: 404 });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map(
      (u) =>
        `  <url><loc>${escape(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`,
    )
    .join('\n')}\n</urlset>\n`;
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
