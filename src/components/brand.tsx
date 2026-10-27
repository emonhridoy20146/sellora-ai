import Link from 'next/link';
import { site } from '@/config/site';
import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-7', className)}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path
        d="M10 20.5c1.4 1.3 3.3 2 5.6 2 3.2 0 5.4-1.5 5.4-3.9 0-2.2-1.6-3.2-4.6-3.8l-1.6-.3c-1.6-.3-2.3-.8-2.3-1.6 0-1 1-1.7 2.6-1.7 1.5 0 2.7.5 3.6 1.4l1.7-2c-1.3-1.2-3.1-1.9-5.2-1.9-3.1 0-5.3 1.6-5.3 4 0 2.1 1.5 3.2 4.4 3.8l1.6.3c1.7.4 2.5.8 2.5 1.7 0 1-1.1 1.7-2.8 1.7-1.7 0-3.1-.6-4.1-1.6L10 20.5Z"
        fill="#fff"
      />
    </svg>
  );
}

export function Brand({ href = '/', suffix }: { href?: string; suffix?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-semibold tracking-tight">
      <BrandMark />
      <span>{site.name}</span>
      {suffix && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {suffix}
        </span>
      )}
    </Link>
  );
}
