'use client';

import { Check, Minus, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { MAX_QUANTITY, useCart } from '@/lib/cart';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/money';
import { reportStep } from '@/lib/shop-steps';
import type { ProductDetail } from '@/lib/types';
import { useAdTags } from './ad-tags';
import { Price } from './price';
import { useShop } from './shop-context';

/** Option picker, quantity and the buttons that put the product in the cart. */
export function AddToCart({ product }: { product: ProductDetail }) {
  const { storeId, language, currency, state, t } = useShop();
  const cart = useCart(storeId);
  const router = useRouter();
  const ads = useAdTags();
  const firstAvailable = product.variants.find((v) => v.available) ?? product.variants[0]!;
  const [choice, setChoice] = useState<string[]>(firstAvailable.optionValues);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);

  const variant = useMemo(
    () => product.variants.find((v) => v.optionValues.every((val, i) => val === choice[i])) ?? null,
    [product.variants, choice],
  );
  const max = variant?.left ?? MAX_QUANTITY;
  const canBuy = Boolean(variant?.available);

  // The store's numbers: shoppers who looked at this product (once a day, counted by the API).
  useEffect(() => {
    if (state === 'open') reportStep('product_view', { productId: product.id });
  }, [state, product.id]);
  // The business's ad tags: a product view, once per product page (ADR 0030).
  const viewed = firstAvailable;
  useEffect(() => {
    ads.track('ViewContent', [
      {
        productId: product.id,
        variantId: viewed.id,
        name: product.name,
        quantity: 1,
        priceMinor: viewed.priceMinor,
      },
    ]);
  }, [ads, product.id, product.name, viewed.id, viewed.priceMinor]);

  const put = () => {
    if (!variant || !canBuy) return false;
    if (state === 'open') reportStep('cart_add');
    ads.track('AddToCart', [
      {
        productId: product.id,
        variantId: variant.id,
        name: product.name,
        quantity: Math.min(quantity, max),
        priceMinor: variant.priceMinor,
      },
    ]);
    cart.add({
      productId: product.id,
      variantId: variant.id,
      quantity: Math.min(quantity, max),
      slug: product.slug,
      name: product.name,
      variantTitle: variant.title === 'Default' ? '' : variant.title,
      image: product.images[0]?.url ?? null,
      priceMinor: variant.priceMinor,
    });
    return true;
  };

  /** Whether choosing `value` for option `index` leads to a variant that is in stock. */
  const valueAvailable = (index: number, value: string) =>
    product.variants.some(
      (v) =>
        v.available &&
        v.optionValues[index] === value &&
        v.optionValues.every((val, i) => i === index || val === choice[i]),
    );

  return (
    <div className="space-y-6">
      {variant ? (
        <Price
          minor={variant.priceMinor}
          compareAtMinor={variant.compareAtPriceMinor}
          currency={currency}
          language={language}
          className="text-2xl"
        />
      ) : null}

      {product.options.map((option, index) => (
        <fieldset key={option.name}>
          <legend className="mb-2 text-sm font-medium">
            {option.name}: <span className="text-muted">{choice[index]}</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {option.values.map((value) => {
              const selected = choice[index] === value;
              const available = valueAvailable(index, value);
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setChoice((c) => c.map((v, i) => (i === index ? value : v)));
                    setAdded(false);
                  }}
                  className={cn(
                    'min-w-12 rounded-store border px-4 py-2 text-sm',
                    selected
                      ? 'border-primary bg-primary text-on-primary'
                      : 'border-line bg-surface hover:border-primary',
                    !available && !selected && 'text-muted line-through decoration-1',
                  )}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      <div className="text-sm">
        {!canBuy ? (
          <span className="font-medium text-red-700">{t.outOfStock}</span>
        ) : variant?.left ? (
          // The accent is the merchant's colour and may be too light for text, so it marks a dot.
          <span className="inline-flex items-center gap-2 font-medium">
            <span aria-hidden className="size-2 rounded-full bg-accent" />
            {t.onlyLeft(formatNumber(variant.left, language))}
          </span>
        ) : (
          <span className="text-muted">{t.inStock}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-12 items-center rounded-store border border-line bg-surface">
          <button
            type="button"
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            className="flex size-12 items-center justify-center disabled:opacity-40"
            disabled={quantity <= 1}
            aria-label="-1"
          >
            <Minus className="size-4" />
          </button>
          <label className="sr-only" htmlFor="qty">
            {t.quantity}
          </label>
          <input
            id="qty"
            inputMode="numeric"
            value={formatNumber(quantity, 'en')}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, ''));
              if (n >= 1) setQuantity(Math.min(n, max));
            }}
            className="w-10 bg-transparent text-center"
          />
          <button
            type="button"
            onClick={() => setQuantity((q) => Math.min(max, q + 1))}
            className="flex size-12 items-center justify-center disabled:opacity-40"
            disabled={quantity >= max}
            aria-label="+1"
          >
            <Plus className="size-4" />
          </button>
        </div>
        <button
          type="button"
          disabled={!canBuy}
          onClick={() => {
            if (put()) setAdded(true);
          }}
          className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-store border-2 border-primary px-5 font-semibold text-primary hover:bg-tint disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
        >
          {added ? <Check className="size-5" aria-hidden="true" /> : null}
          {added ? t.added : t.addToCart}
        </button>
        <button
          type="button"
          disabled={!canBuy}
          onClick={() => {
            if (put()) router.push('/checkout');
          }}
          className="inline-flex h-12 w-full items-center justify-center rounded-store bg-primary px-6 font-semibold text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          {t.buyNow}
        </button>
      </div>
      <p className="sr-only" aria-live="polite">
        {added ? t.added : ''}
      </p>
    </div>
  );
}
