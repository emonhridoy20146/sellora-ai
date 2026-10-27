import { Package } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Small square product photo, or a placeholder icon. */
export function ProductThumb({ url, className }: { url?: string | null; className?: string }) {
  return (
    <span
      className={cn(
        'flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted',
        className,
      )}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- merchant-supplied URLs
        <img src={url} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        <Package className="size-4 text-muted-foreground" aria-hidden />
      )}
    </span>
  );
}
