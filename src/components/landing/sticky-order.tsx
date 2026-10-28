'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { ORDER_ANCHOR } from '@/lib/landing-offer';

/** The order button kept at the bottom of a phone's screen, hidden while the form is in view. */
export function StickyOrder({ label }: { label: string }) {
  const [formInView, setFormInView] = useState(false);
  useEffect(() => {
    const form = document.getElementById(ORDER_ANCHOR);
    if (!form || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => setFormInView(Boolean(entry?.isIntersecting)),
      {
        threshold: 0.05,
      },
    );
    io.observe(form);
    return () => io.disconnect();
  }, []);
  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 p-3 backdrop-blur transition-transform md:hidden',
        formInView && 'translate-y-full',
      )}
      aria-hidden={formInView}
    >
      <a
        href={`#${ORDER_ANCHOR}`}
        tabIndex={formInView ? -1 : undefined}
        className="flex h-12 w-full items-center justify-center rounded-store bg-primary text-lg font-bold text-on-primary shadow"
      >
        {label}
      </a>
    </div>
  );
}
