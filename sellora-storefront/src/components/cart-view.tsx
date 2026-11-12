'use client';

import { Minus, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { MAX_QUANTITY, useCart, type CartItem } from '@/lib/cart';
import { formatMoney, formatNumber } from '@/lib/money';
import { readJson } from '@/lib/problem';
import type { Quote } from '@/lib/types';
import { useShop } from './shop-context';

/** Prices the cart on the server whenever it or the delivery area changes. */
export function useQuote(
  items: CartItem[],
  zoneId: string | null | undefined,
  /** A coupon code to price the cart with (ADR 0031), and the phone typed so far. */
  coupon?: { code: string; phone?: string | undefined } | null,
) {
  const { t } = useShop();
  const code = coupon?.code ?? null;
  const phone = coupon?.phone ?? null;
  const key = useMemo(
    () =>
      JSON.stringify([
        items.map((i) => [i.productId, i.variantId, i.quantity]),
        zoneId,
        code,
        code ? phone : null,
      ]),
    [items, zoneId, code, phone],
  );
  // The answer for the cart as it was when asked; a newer cart means a new answer is coming.
  const [result, setResult] = useState<{ key: string; quote: Quote | null; error: string | null }>({
    key: '',
    quote: null,
    error: null,
  });

  useEffect(() => {
    const [lines, zone, couponCode, couponPhone] = JSON.parse(key) as [
      [string, string, number][],
      string | null | undefined,
      string | null,
      string | null,
    ];
    if (!lines.length) return;
    const ctrl = new AbortController();
    fetch('/api/cart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: lines.map(([productId, variantId, quantity]) => ({
          productId,
          variantId,
          quantity,
        })),
        ...(zone !== undefined ? { zoneId: zone } : {}),
        ...(couponCode ? { couponCode } : {}),
        ...(couponCode && couponPhone ? { phone: couponPhone } : {}),
      }),
      signal: ctrl.signal,
    })
      .then((res) => readJson<Quote>(res, t))
      .then((r) =>
        setResult((prev) =>
          r.ok
            ? { key, quote: r.data, error: null }
            : { key, quote: prev.quote, error: r.problem.detail },
        ),
      )
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError')
          setResult((prev) => ({ key, quote: prev.quote, error: t.tryAgain }));
      });
    return () => ctrl.abort();
  }, [key, t]);

  const empty = items.length === 0;
  return {
    quote: empty ? null : result.quote,
    error: empty ? null : result.error,
    loading: !empty && result.key !== key,
  };
}

export function CartView() {
  const { storeId, language, currency, t } = useShop();
  const cart = useCart(storeId);
  const { quote, error, loading } = useQuote(cart.items, undefined);
  const money = (minor: number) => formatMoney(minor, quote?.currency ?? currency, language);

  if (!cart.items.length)
    return (
      <div className="rounded-store-lg border border-dashed border-line p-12 text-center">
        <p className="text-muted">{t.cartEmpty}</p>
        <Link
          href="/products"
          className="mt-5 inline-flex h-11 items-center rounded-store bg-primary px-5 font-medium text-on-primary"
        >
          {t.continueShopping}
        </Link>
      </div>
    );

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
      <ul className="divide-y divide-line rounded-store-lg border border-line bg-surface">
        {cart.items.map((item) => {
          const line = quote?.lines.find((l) => l.variantId === item.variantId);
          const max = line?.maxQuantity ?? MAX_QUANTITY;
          return (
            <li key={item.variantId} className="flex gap-4 p-4">
              <Link
                href={`/products/${encodeURIComponent(item.slug)}`}
                className="size-20 shrink-0 overflow-hidden rounded-store bg-tint"
              >
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.image} alt="" className="size-full object-cover" />
                ) : null}
              </Link>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/products/${encodeURIComponent(item.slug)}`}
                      className="line-clamp-2 font-medium hover:underline"
                    >
                      {line?.name ?? item.name}
                    </Link>
                    {(line?.variantTitle ?? item.variantTitle) ? (
                      <p className="text-sm text-muted">
                        {line?.variantTitle ?? item.variantTitle}
                      </p>
                    ) : null}
                  </div>
                  <p className="shrink-0 font-semibold">
                    {money(line?.totalMinor ?? item.priceMinor * item.quantity)}
                  </p>
                </div>
                {line?.problem ? (
                  <p className="text-sm font-medium text-red-700" role="status">
                    {t.lineProblem[line.problem]}
                    {line.problem === 'not_enough_stock' && line.maxQuantity
                      ? ` · ${t.maxAvailable(formatNumber(line.maxQuantity, language))}`
                      : ''}
                  </p>
                ) : null}
                <div className="mt-auto flex items-center justify-between">
                  <div className="flex h-9 items-center rounded-store border border-line">
                    <button
                      type="button"
                      aria-label="-1"
                      disabled={item.quantity <= 1}
                      onClick={() => cart.setQuantity(item.variantId, item.quantity - 1)}
                      className="flex size-9 items-center justify-center disabled:opacity-40"
                    >
                      <Minus className="size-3.5" />
                    </button>
                    <span className="w-8 text-center text-sm" aria-label={t.quantity}>
                      {formatNumber(item.quantity, language)}
                    </span>
                    <button
                      type="button"
                      aria-label="+1"
                      disabled={item.quantity >= Math.max(1, max)}
                      onClick={() => cart.setQuantity(item.variantId, item.quantity + 1)}
                      className="flex size-9 items-center justify-center disabled:opacity-40"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => cart.remove(item.variantId)}
                    className="inline-flex items-center gap-1 text-sm text-muted hover:text-red-700"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    {t.remove}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <aside className="h-fit rounded-store-lg border border-line bg-surface p-5">
        <h2 className="font-semibold">{t.orderSummary}</h2>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">{t.subtotal}</dt>
            <dd>{quote ? money(quote.subtotalMinor) : '…'}</dd>
          </div>
        </dl>
        {quote?.belowMinimum ? (
          <p className="mt-3 text-sm text-red-700">{t.minimumOrder(money(quote.minOrderMinor))}</p>
        ) : null}
        {quote && quote.lines.some((l) => l.problem) ? (
          <p className="mt-3 text-sm text-red-700">{t.fixCart}</p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        <Link
          href="/checkout"
          aria-disabled={!quote || quote.lines.some((l) => l.problem) || quote.belowMinimum}
          className="mt-5 flex h-12 items-center justify-center rounded-store bg-primary font-semibold text-on-primary hover:opacity-90 aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          {loading && !quote ? t.checking : t.checkout}
        </Link>
        <Link href="/products" className="mt-3 block text-center text-sm text-muted hover:text-ink">
          {t.continueShopping}
        </Link>
      </aside>
    </div>
  );
}
