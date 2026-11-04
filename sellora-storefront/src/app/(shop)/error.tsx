'use client';

import { useShop } from '@/components/shop-context';

export default function ShopError({ reset }: { error: Error; reset: () => void }) {
  const { t } = useShop();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center">
      <h1 className="text-xl font-semibold">{t.tryAgain}</h1>
      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex h-11 items-center rounded-store bg-primary px-5 font-medium text-on-primary"
      >
        {t.tryAgain}
      </button>
    </div>
  );
}
