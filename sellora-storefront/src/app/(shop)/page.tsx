import type { Metadata } from 'next';
import { JsonLd } from '@/components/json-ld';
import { HomeSections } from '@/components/sections/sections';
import { apiGet } from '@/lib/api';
import { openStore } from '@/lib/page-store';
import { shopLd } from '@/lib/structured-data';
import type { HomeData } from '@/lib/types';

export const metadata: Metadata = { alternates: { canonical: '/' } };

export default async function HomePage() {
  const store = await openStore();
  const home = await apiGet<HomeData>('/home');
  return (
    <>
      <JsonLd data={shopLd(store)} />
      <HomeSections store={store} home={home} />
    </>
  );
}
