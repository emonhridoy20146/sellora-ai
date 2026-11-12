import { Star } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Dictionary } from '@/lib/i18n';
import { ORDER_ANCHOR, headlinePrice } from '@/lib/landing-offer';
import type { LandingView } from '@/lib/types';

/** What every section may read: the page, its words, and money in its language. */
export interface Ctx {
  view: LandingView;
  t: Dictionary;
  money: (minor: number) => string;
}

export function Title({ children, className }: { children: string; className?: string }) {
  if (!children) return null;
  return (
    <h2
      className={cn(
        'mb-6 text-center font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl',
        className,
      )}
    >
      {children}
    </h2>
  );
}

export function OrderButton({ label, className }: { label: string; className?: string }) {
  return (
    <a
      href={`#${ORDER_ANCHOR}`}
      className={cn(
        'inline-flex h-13 items-center justify-center rounded-store bg-primary px-8 text-lg font-semibold text-on-primary shadow-sm hover:opacity-90',
        className,
      )}
    >
      {label}
    </a>
  );
}

export function PriceTag({ ctx, size = 'lg' }: { ctx: Ctx; size?: 'lg' | 'xl' }) {
  const price = headlinePrice(ctx.view);
  if (!price) return null;
  return (
    <p className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1">
      <span
        className={cn(
          'font-bold text-primary',
          size === 'xl' ? 'text-4xl sm:text-5xl' : 'text-3xl',
        )}
      >
        {ctx.money(price.priceMinor)}
      </span>
      {price.regularMinor > price.priceMinor ? (
        <span className="text-lg text-muted line-through">
          <span className="sr-only">{ctx.t.regularPrice}: </span>
          {ctx.money(price.regularMinor)}
        </span>
      ) : null}
    </p>
  );
}

export function Stars({ rating, label }: { rating: number; label: string }) {
  return (
    <span className="flex gap-0.5" role="img" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn('size-4', n <= rating ? 'fill-amber-400 text-amber-400' : 'text-line')}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
