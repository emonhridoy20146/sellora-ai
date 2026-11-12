'use client';

import { BadgePercent, Check, X } from 'lucide-react';
import { useState } from 'react';
import type { Dictionary } from '@/lib/i18n';

/** What the box shows about the code: applied, refused (with why), or being checked. */
export type CouponBoxState =
  | { status: 'idle' }
  | { status: 'checking'; code: string }
  | { status: 'applied'; code: string }
  | { status: 'refused'; code: string; message: string };

/**
 * A coupon code box for the store checkout and a landing page's order form (ADR 0031).
 * Folded behind a link until the shopper wants it; the API checks every code.
 */
export function CouponBox({
  id,
  t,
  state,
  open: openProp,
  onApply,
  onRemove,
}: {
  id: string;
  t: Dictionary;
  state: CouponBoxState;
  /** Opened from outside (a coupon banner's "Use this code"). */
  open?: boolean;
  onApply: (code: string) => void;
  onRemove: () => void;
}) {
  const [openSelf, setOpenSelf] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const open = openSelf || openProp || state.status !== 'idle';
  const value = typed ?? (state.status === 'idle' ? '' : state.code);

  if (state.status === 'applied')
    return (
      <div className="flex items-center justify-between gap-3 rounded-store border-2 border-dashed border-primary bg-tint px-3 py-2 text-sm">
        <span className="flex items-center gap-2 font-semibold text-primary" role="status">
          <Check className="size-4" aria-hidden="true" /> {t.couponApplied(state.code)}
        </span>
        <button
          type="button"
          onClick={() => {
            setTyped('');
            onRemove();
          }}
          className="inline-flex items-center gap-1 text-muted hover:text-ink"
        >
          <X className="size-4" aria-hidden="true" /> {t.remove}
        </button>
      </div>
    );

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpenSelf(true)}
        className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
      >
        <BadgePercent className="size-4" aria-hidden="true" /> {t.haveCoupon}
      </button>
    );

  const apply = () => {
    const code = value.trim();
    if (code) onApply(code);
  };
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold">
        {t.couponCode}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          value={value}
          maxLength={40}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            // Enter applies the code instead of placing the order.
            if (e.key === 'Enter') {
              e.preventDefault();
              apply();
            }
          }}
          className="h-11 min-w-0 flex-1 rounded-store border border-line bg-surface px-3 font-mono text-base text-ink uppercase aria-invalid:border-red-600"
          {...(state.status === 'refused'
            ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` }
            : {})}
        />
        <button
          type="button"
          onClick={apply}
          disabled={state.status === 'checking' || !value.trim()}
          className="h-11 shrink-0 rounded-store border-2 border-primary px-4 text-sm font-semibold text-primary disabled:opacity-50"
        >
          {state.status === 'checking' ? t.couponChecking : t.apply}
        </button>
      </div>
      {state.status === 'refused' ? (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
