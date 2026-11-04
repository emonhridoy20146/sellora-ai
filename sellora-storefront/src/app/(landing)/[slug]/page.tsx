import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { LandingHolding, LandingPageView } from '@/components/landing/landing-page';
import { getLanding } from '@/lib/landing';
import { PATH_HEADER, mainAddressRedirect } from '@/lib/main-address';
import { isShown } from '@/lib/types';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const landing = await getLanding((await params).slug);
  if (!landing) return { robots: { index: false, follow: false } };
  if (!isShown(landing))
    return { title: landing.store.name, robots: { index: false, follow: false } };
  const { seo, page, store } = landing;
  return {
    metadataBase: new URL(page.url),
    title: seo.title,
    description: seo.description || undefined,
    alternates: { canonical: page.url },
    openGraph: {
      type: 'website',
      siteName: store.name,
      title: seo.title,
      ...(seo.description ? { description: seo.description } : {}),
      url: page.url,
      ...(seo.image ? { images: [seo.image] } : {}),
    },
    // Previews are never listed; pages made only for ads can ask not to be.
    robots: seo.index ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default async function LandingRoute({ params }: Props) {
  const landing = await getLanding((await params).slug);
  if (!landing) notFound();
  // A live page lives at one address, like the shop: its other addresses send shoppers there.
  if (landing.state === 'live') {
    const h = await headers();
    const to = mainAddressRedirect(landing.store.url, h.get('host'), h.get(PATH_HEADER));
    if (to) permanentRedirect(to);
  }
  if (!isShown(landing)) return <LandingHolding landing={landing} />;
  return <LandingPageView view={landing} />;
}
