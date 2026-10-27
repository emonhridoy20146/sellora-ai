'use client';

import type { LucideIcon } from 'lucide-react';
import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  /** Not built yet: shown so people see what is coming, but not clickable. */
  soon?: boolean;
  badge?: string | number;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

function NavLinks({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-5 px-3 py-4">
      {sections.map((section, i) => (
        <div key={section.label ?? i} className="flex flex-col gap-0.5">
          {section.label && (
            <p className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {section.label}
            </p>
          )}
          {section.items.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            const Icon = item.icon;
            if (item.soon) {
              return (
                <span
                  key={item.href}
                  aria-disabled="true"
                  title="Not available yet"
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground/70"
                >
                  <Icon className="size-4" aria-hidden />
                  <span className="flex-1">{item.label}</span>
                  <Badge tone="outline" className="px-1.5 py-0 text-[10px]">
                    Soon
                  </Badge>
                </span>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <Icon className={cn('size-4', active && 'text-primary')} aria-hidden />
                <span className="flex-1">{item.label}</span>
                {item.badge !== undefined && item.badge !== 0 && (
                  <Badge tone="warning" className="px-1.5 py-0 text-[10px]">
                    {item.badge}
                  </Badge>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/**
 * The signed-in frame: a sidebar on desktop, a drawer on phones, a top bar with the
 * account menu. Used by both the merchant dashboard and the super-admin panel.
 */
export function AppShell({
  brand,
  switcher,
  sections,
  topRight,
  banner,
  children,
}: {
  brand: React.ReactNode;
  switcher?: React.ReactNode;
  sections: NavSection[];
  topRight: React.ReactNode;
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-sidebar lg:flex">
        <div className="flex h-14 items-center border-b px-4">{brand}</div>
        {switcher && <div className="border-b p-3">{switcher}</div>}
        <div className="flex-1 overflow-y-auto">
          <NavLinks sections={sections} />
        </div>
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-sidebar shadow-xl">
            <div className="flex h-14 items-center justify-between border-b px-4">
              {brand}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
              >
                <X />
              </Button>
            </div>
            {switcher && <div className="border-b p-3">{switcher}</div>}
            <div className="flex-1 overflow-y-auto">
              <NavLinks sections={sections} onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur sm:px-6">
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <Menu />
          </Button>
          <div className="lg:hidden">{brand}</div>
          <div className="ml-auto flex items-center gap-1">{topRight}</div>
        </header>
        {banner}
        <main
          id="main"
          key={pathname}
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
