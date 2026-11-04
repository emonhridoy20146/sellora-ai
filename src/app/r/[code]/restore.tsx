'use client';

import { useEffect } from 'react';
import type { CartItem } from '@/lib/cart-lines';
import { setCartToken } from '@/lib/cart-capture';
import { DETAILS_KEY, parseDetails, readRaw, save } from '@/lib/shopper';

export interface RestorePlan {
  /** Where the shopper goes next. */
  to: string;
  /** The store cart to put back (store carts only). */
  cart: { key: string; items: CartItem[] } | null;
  /** The cart token, so later changes keep updating the same saved cart. */
  token: { key: string; value: string } | null;
  customer: { name: string; phone: string };
}

/** Puts the cart and the shopper's name and number back in this browser, then moves on. */
export function RestoreCart({
  plan,
  label,
  open,
}: {
  plan: RestorePlan;
  label: string;
  open: string;
}) {
  useEffect(() => {
    if (plan.cart) {
      try {
        localStorage.setItem(plan.cart.key, JSON.stringify(plan.cart.items));
      } catch {
        // Without storage the checkout shows an empty cart; the link below still opens the shop.
      }
    }
    if (plan.token) setCartToken(plan.token.key, plan.token.value);
    const saved = parseDetails(readRaw(DETAILS_KEY));
    save(
      DETAILS_KEY,
      {
        ...saved,
        name: plan.customer.name || saved.name,
        phone: plan.customer.phone || saved.phone,
        email: '',
      },
      'local',
    );
    window.location.replace(plan.to);
  }, [plan]);

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-16">
      <div className="text-center" role="status">
        <span
          className="mx-auto mb-4 block size-8 animate-spin rounded-full border-2 border-line border-t-primary"
          aria-hidden="true"
        />
        <p className="font-medium">{label}</p>
        <a href={plan.to} className="mt-3 inline-block text-sm text-primary underline">
          {open}
        </a>
      </div>
    </main>
  );
}
