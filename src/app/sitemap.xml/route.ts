import { ApiError, apiGet, contextFrom } from '@/lib/api';
import { getStore } from '@/lib/api';
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

/** Pages of an open store, for search engines. Closed stores and previews have none. */
export async function GET(req: NextRequest) {
  const store = await getStore();
  if (!store || store.state !== 'open') return new Response('Not found', { status: 404 });
  let data: SitemapData;
  try {
    data = await apiGet<SitemapData>('/sitemap', contextFrom(req.headers, undefined));
  } catch (err) {
    if (err instanceof ApiError && err.problem.status === 404)
      return new Response('Not found', { status: 404 });
    throw err;
  }
  const base = store.url.replace(/\/$/, '');
  const urls = [
    { loc: `${base}/`, lastmod: data.updatedAt },
    { loc: `${base}/products`, lastmod: data.updatedAt },
    ...data.categories.map((c) => ({ loc: `${base}/products?category=${encodeURIComponent(c)}` })),
    ...data.products.map((p) => ({
      loc: `${base}/products/${encodeURIComponent(p.slug)}`,
      lastmod: p.updatedAt,
    })),
    ...data.pages.map((p) => ({ loc: `${base}/pages/${p}` })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map(
      (u) =>
        `  <url><loc>${escape(u.loc)}</loc>${'lastmod' in u && u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`,
    )
    .join('\n')}\n</urlset>\n`;
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
