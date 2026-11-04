import { headers } from 'next/headers';
import { contextFrom, getStore } from '@/lib/api';
import { landingSitemap } from '@/lib/landing-sitemap';

const text = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });

/**
 * Open stores may be indexed (except carts, orders and thank-you pages). A store that is not
 * open may still have live landing pages: only those may be indexed. Anything else may not.
 */
export async function GET() {
  const store = await getStore();
  if (!store || store.state === 'preview') return text('User-agent: *\nDisallow: /\n');
  const base = store.url.replace(/\/$/, '');
  if (store.state === 'open')
    return text(
      `User-agent: *\nDisallow: /cart\nDisallow: /checkout\nDisallow: /order\nDisallow: /api/\nDisallow: /*/thanks\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`,
    );
  const pages = await landingSitemap(contextFrom(await headers(), undefined));
  if (!pages.length) return text('User-agent: *\nDisallow: /\n');
  return text(
    `User-agent: *\n${pages.map((p) => `Allow: /${p.slug}$`).join('\n')}\nDisallow: /\n\nSitemap: ${base}/sitemap.xml\n`,
  );
}
