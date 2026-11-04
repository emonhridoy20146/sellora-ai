import Link from 'next/link';
import { getStore } from '@/lib/api';
import { dictionary } from '@/lib/i18n';

export default async function NotFound() {
  const store = await getStore();
  const t = dictionary(store?.language ?? 'en');
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center">
      <p className="font-display text-5xl font-semibold text-primary">404</p>
      <h1 className="mt-4 text-xl font-semibold">{t.notFound}</h1>
      <p className="mt-2 text-sm text-muted">{t.notFoundText}</p>
      <Link
        href="/"
        className="mt-6 inline-flex h-11 items-center rounded-store bg-primary px-5 font-medium text-on-primary"
      >
        {t.backHome}
      </Link>
    </div>
  );
}
