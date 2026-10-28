'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useShop } from './shop-context';

export function SortSelect({ value }: { value: string }) {
  const { t } = useShop();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">{t.sort}</span>
      <select
        value={value}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          next.set('sort', e.target.value);
          next.delete('page');
          router.push(`${pathname}?${next.toString()}`);
        }}
        className="h-10 rounded-store border border-line bg-surface px-3 text-ink"
      >
        <option value="newest">{t.sortNewest}</option>
        <option value="popular">{t.sortPopular}</option>
        <option value="price_asc">{t.sortPriceAsc}</option>
        <option value="price_desc">{t.sortPriceDesc}</option>
      </select>
    </label>
  );
}
