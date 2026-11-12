'use client';

import { ORDER_ANCHOR } from '@/lib/landing-offer';
import { cn } from '@/lib/cn';

/** Sections ask the order form to choose a package or use a code (ADR 0031). */
export const PICK_PACKAGE_EVENT = 'sl:landing-package';
export const USE_COUPON_EVENT = 'sl:landing-coupon';

function toForm(event: string, detail: string) {
  window.dispatchEvent(new CustomEvent<string>(event, { detail }));
  document.getElementById(ORDER_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** "Choose" on a package card: the order form selects it and comes into view. */
export function PackageButton({ id, label }: { id: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => toForm(PICK_PACKAGE_EVENT, id)}
      className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-store bg-primary px-5 font-semibold text-on-primary hover:opacity-90"
    >
      {label}
    </button>
  );
}

/** "Use this code" on a coupon banner: the order form applies it. */
export function UseCodeButton({
  code,
  label,
  className,
}: {
  code: string;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => toForm(USE_COUPON_EVENT, code)}
      className={cn(
        'inline-flex h-11 items-center justify-center rounded-store bg-primary px-5 font-semibold text-on-primary hover:opacity-90',
        className,
      )}
    >
      {label}
    </button>
  );
}
