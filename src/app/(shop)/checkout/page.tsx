import type { Metadata } from 'next';
import { CheckoutForm } from '@/components/checkout-form';
import { dictionary } from '@/lib/i18n';
import { openStore } from '@/lib/page-store';

export async function generateMetadata(): Promise<Metadata> {
  const store = await openStore();
  return { title: dictionary(store.language).checkout, robots: { index: false } };
}

export default async function CheckoutPage() {
  const store = await openStore();
  const t = dictionary(store.language);
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight sm:text-3xl">{t.checkout}</h1>
      <CheckoutForm />
    </div>
  );
}
