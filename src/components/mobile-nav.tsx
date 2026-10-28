'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useShop } from './shop-context';

export function MobileNav({ links }: { links: { href: string; label: string }[] }) {
  const { t } = useShop();
  const pathname = usePathname();
  // Open on one page only: following a link closes the menu.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpenOn(open ? null : pathname)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? t.close : t.menu}
        className="inline-flex size-10 items-center justify-center rounded-store hover:bg-black/5"
      >
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </button>
      {open ? (
        <nav
          id="mobile-nav"
          className="absolute inset-x-0 top-full z-40 border-b border-line bg-surface text-ink shadow-lg"
        >
          <ul className="mx-auto flex max-w-6xl flex-col px-4 py-2">
            {links.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="block py-3 text-base font-medium">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
