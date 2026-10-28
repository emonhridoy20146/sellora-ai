import type { Metadata } from 'next';
import { TrackForm } from '@/components/track-form';
import { dictionary } from '@/lib/i18n';
import { openStore } from '@/lib/page-store';

export async function generateMetadata(): Promise<Metadata> {
  const store = await openStore();
  return { title: dictionary(store.language).trackTitle };
}

export default async function TrackPage() {
  const store = await openStore();
  const t = dictionary(store.language);
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight sm:text-3xl">{t.trackTitle}</h1>
      <TrackForm />
    </div>
  );
}
