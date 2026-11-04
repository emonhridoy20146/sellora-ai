'use client';

import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Settings, Store } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api, type Realm } from '@/lib/api/client';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase() ||
    '?'
  );
}

export function UserMenu({
  name,
  email,
  realm,
  links = [],
}: {
  name: string;
  email: string;
  realm: Realm;
  links?: { href: string; label: string; icon: typeof Settings }[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const signOut = async () => {
    await api(realm === 'platform' ? '/platform/auth/logout' : '/auth/logout', {
      method: 'POST',
      noRefresh: true,
    }).catch(() => undefined);
    queryClient.clear();
    router.replace(realm === 'platform' ? '/admin/login' : '/login');
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
        aria-label="Account menu"
      >
        {initials(name)}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuLabel>
          <span className="block truncate text-sm font-medium text-foreground">{name}</span>
          <span className="block truncate">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {links.map((l) => (
          <DropdownMenuItem key={l.href} asChild>
            <Link href={l.href}>
              <l.icon />
              {l.label}
            </Link>
          </DropdownMenuItem>
        ))}
        {links.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const merchantMenuLinks = [
  { href: '/app/account', label: 'Your account', icon: Settings },
  { href: '/app?choose=1', label: 'Switch business', icon: Store },
];
