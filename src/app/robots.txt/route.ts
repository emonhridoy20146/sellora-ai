import { getStore } from '@/lib/api';

/** Open stores may be indexed (except carts and orders); anything else may not. */
export async function GET() {
  const store = await getStore();
  const body =
    store && store.state === 'open'
      ? `User-agent: *\nDisallow: /cart\nDisallow: /checkout\nDisallow: /order\nDisallow: /api/\nAllow: /\n\nSitemap: ${store.url.replace(/\/$/, '')}/sitemap.xml\n`
      : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
