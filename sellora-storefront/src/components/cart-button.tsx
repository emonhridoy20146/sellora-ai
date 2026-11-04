'use client';

import { ShoppingBag } from 'lucide-react';
import Link from 'next/link';
import { useCart } from '@/lib/cart';
import { formatNumber } from '@/lib/money';
import { useShop } from './shop-context';

export function CartButton() {
  const { storeId, language, t } = useShop();
  const { count } = useCart(storeId);
  return (
    <Link
      href="/cart"
      className="relative inline-flex size-10 items-center justify-center rounded-store hover:bg-black/5"
      aria-label={count ? `${t.cart} (${count})` : t.cart}
    >
      <ShoppingBag className="size-5" aria-hidden="true" />
      {count > 0 ? (
        <span className="absolute -top-0.5 -right-0.5 flex min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] leading-5 font-semibold text-on-accent">
          {formatNumber(count, language)}
        </span>
      ) : null}
    </Link>
  );
}
