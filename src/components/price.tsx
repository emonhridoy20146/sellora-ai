import { formatMoney } from '@/lib/money';
import type { Language } from '@/lib/types';
import { cn } from '@/lib/cn';

/** A price, with the old price struck through when there is one. */
export function Price({
  minor,
  compareAtMinor,
  currency,
  language,
  from,
  className,
}: {
  minor: number;
  compareAtMinor?: number | null;
  currency: string;
  language: Language;
  from?: string;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex flex-wrap items-baseline gap-x-2', className)}>
      <span className="font-semibold text-ink">
        {from ? <span className="mr-1 text-sm font-normal text-muted">{from}</span> : null}
        {formatMoney(minor, currency, language)}
      </span>
      {compareAtMinor && compareAtMinor > minor ? (
        <s className="text-sm text-muted">{formatMoney(compareAtMinor, currency, language)}</s>
      ) : null}
    </span>
  );
}
