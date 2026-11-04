'use client';

import { Brand } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';
import { UserMenu, merchantMenuLinks } from '@/components/layout/user-menu';
import { useMe } from '@/lib/api/queries';

/** Header-only frame for signed-in pages that are not inside one business. */
export function SimpleFrame({ children }: { children: React.ReactNode }) {
  const me = useMe();
  return (
    <div className="min-h-dvh">
      <header className="flex h-14 items-center justify-between border-b px-4 sm:px-6">
        <Brand href="/app?choose=1" />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          {me.data && (
            <UserMenu
              realm="merchant"
              name={me.data.user.name}
              email={me.data.user.email}
              links={merchantMenuLinks}
            />
          )}
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </main>
    </div>
  );
}
