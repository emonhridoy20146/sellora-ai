import type * as React from 'react';
import { cn } from '@/lib/utils';

export const inputClass =
  'flex h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs transition-colors outline-none placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20';

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input className={cn(inputClass, 'file:border-0 file:bg-transparent', className)} {...props} />
  );
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea className={cn(inputClass, 'h-auto min-h-20 py-2', className)} {...props} />;
}

/** A native select: accessible, keyboard and mobile friendly with no extra script. */
export function NativeSelect({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select className={cn(inputClass, 'appearance-auto pr-8', className)} {...props}>
      {children}
    </select>
  );
}
