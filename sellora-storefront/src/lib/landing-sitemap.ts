import 'server-only';
import { apiGet, type ShopContext } from './api';

/** Live landing pages of the store that search engines may list (none when it may not show any). */
export async function landingSitemap(
  ctx: ShopContext,
): Promise<{ slug: string; updatedAt: string }[]> {
  try {
    return (await apiGet<{ items: { slug: string; updatedAt: string }[] }>('/landing-pages', ctx))
      .items;
  } catch {
    // The shop's own pages still go out; landing pages come back on the next crawl.
    return [];
  }
}
