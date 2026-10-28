import { HomeSections } from '@/components/sections/sections';
import { apiGet } from '@/lib/api';
import { openStore } from '@/lib/page-store';
import type { HomeData } from '@/lib/types';

export default async function HomePage() {
  const store = await openStore();
  const home = await apiGet<HomeData>('/home');
  return <HomeSections store={store} home={home} />;
}
