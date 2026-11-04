'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';

export function Gallery({
  images,
  name,
}: {
  images: { url: string; alt: string }[];
  name: string;
}) {
  const [active, setActive] = useState(0);
  const current = images[active];
  return (
    <div>
      <div className="aspect-square overflow-hidden rounded-store-lg bg-tint">
        {current ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={current.url} alt={current.alt} className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center p-6 text-center font-display text-2xl text-muted">
            {name}
          </div>
        )}
      </div>
      {images.length > 1 ? (
        <ul className="mt-3 grid grid-cols-5 gap-2">
          {images.map((img, i) => (
            <li key={img.url}>
              <button
                type="button"
                onClick={() => setActive(i)}
                aria-label={`${i + 1} / ${images.length}`}
                aria-pressed={i === active}
                className={cn(
                  'aspect-square w-full overflow-hidden rounded-store border-2',
                  i === active
                    ? 'border-primary'
                    : 'border-transparent opacity-80 hover:opacity-100',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt="" loading="lazy" className="size-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
