import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError, apiGet } from '@/lib/api';
import { dictionary } from '@/lib/i18n';
import { openStore } from '@/lib/page-store';
import type { PageKey } from '@/lib/types';

const KEYS: PageKey[] = ['about', 'shipping', 'returns', 'privacy', 'terms'];

function pageKey(raw: string): PageKey {
  const key = KEYS.find((k) => k === raw);
  if (!key) notFound();
  return key;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const store = await openStore();
  const key = pageKey((await params).key);
  return {
    title: dictionary(store.language).pages[key],
    alternates: { canonical: `/pages/${key}` },
  };
}

export default async function InfoPage({ params }: { params: Promise<{ key: string }> }) {
  const store = await openStore();
  const t = dictionary(store.language);
  const key = pageKey((await params).key);
  let text: string;
  try {
    text = (await apiGet<{ text: string }>(`/pages/${key}`)).text;
  } catch (err) {
    if (err instanceof ApiError && err.problem.status === 404) notFound();
    throw err;
  }
  return (
    <article className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight sm:text-3xl">{t.pages[key]}</h1>
      <div className="prose-store leading-relaxed text-ink/85">
        {text.split(/\n{2,}/).map((p, i) => (
          <p key={i} className="whitespace-pre-line">
            {p}
          </p>
        ))}
      </div>
    </article>
  );
}
