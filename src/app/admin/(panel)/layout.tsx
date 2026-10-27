'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Banknote,
  Building2,
  Cpu,
  CreditCard,
  Gauge,
  KeyRound,
  Layers,
  ScrollText,
  Settings,
  ShieldCheck,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useMemo } from 'react';
import { SessionGate } from '@/components/auth/session-gate';
import { Brand } from '@/components/brand';
import { AppShell, type NavSection } from '@/components/layout/app-shell';
import { UserMenu } from '@/components/layout/user-menu';
import { PlatformProvider } from '@/components/platform-context';
import { ThemeToggle } from '@/components/theme-toggle';
import { api } from '@/lib/api/client';
import { usePlatformMe } from '@/lib/api/queries';
import type { BillingOverview } from '@/lib/api/types';

function nav(can: (p: string) => boolean, queues?: BillingOverview['queues']): NavSection[] {
  const s: NavSection[] = [
    {
      items: [
        { href: '/admin', label: 'Overview', icon: Gauge, exact: true },
        ...(can('platform.tenants.view')
          ? [{ href: '/admin/tenants', label: 'Businesses', icon: Building2 }]
          : []),
        ...(can('platform.users.view')
          ? [{ href: '/admin/users', label: 'Merchant users', icon: Users }]
          : []),
      ],
    },
  ];
  if (can('platform.billing.view')) {
    s.push({
      label: 'Money',
      items: [
        {
          href: '/admin/payments',
          label: 'Payments',
          icon: CreditCard,
          badge: queues?.pendingManualPayments,
        },
        {
          href: '/admin/withdrawals',
          label: 'Withdrawals',
          icon: Banknote,
          badge: queues?.openWithdrawals,
        },
        { href: '/admin/profit', label: 'AI revenue & profit', icon: TrendingUp },
        { href: '/admin/plans', label: 'Plans', icon: Layers },
        { href: '/admin/ai-pricing', label: 'AI credits & models', icon: Cpu },
        { href: '/admin/gateways', label: 'Payment gateways', icon: KeyRound },
      ],
    });
  }
  const system: NavSection = { label: 'Platform', items: [] };
  if (can('platform.admins.view'))
    system.items.push({ href: '/admin/admins', label: 'Team', icon: ShieldCheck });
  if (can('platform.settings.manage'))
    system.items.push({ href: '/admin/settings', label: 'Settings', icon: Settings });
  if (can('platform.audit.view'))
    system.items.push({ href: '/admin/audit', label: 'Audit log', icon: ScrollText });
  if (system.items.length) s.push(system);
  return s;
}

export default function AdminPanelLayout({ children }: { children: React.ReactNode }) {
  const me = usePlatformMe();
  const can = useMemo(() => {
    const set = new Set(me.data?.permissions ?? []);
    return (p: string) => set.has(p);
  }, [me.data]);
  const overview = useQuery({
    queryKey: ['platform', 'billing', 'overview'],
    queryFn: () => api<BillingOverview>('/platform/billing/overview'),
    enabled: can('platform.billing.view'),
    refetchInterval: 60_000,
  });

  return (
    <SessionGate realm="platform" query={me}>
      {me.data && (
        <PlatformProvider value={{ me: me.data, can }}>
          <AppShell
            brand={<Brand href="/admin" suffix="Platform" />}
            sections={nav(can, overview.data?.queues)}
            topRight={
              <>
                <span className="mr-2 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                  <ShieldCheck className="size-3.5" aria-hidden /> {me.data.role}
                </span>
                <ThemeToggle />
                <UserMenu realm="platform" name={me.data.name} email={me.data.email} />
              </>
            }
          >
            {children}
          </AppShell>
        </PlatformProvider>
      )}
    </SessionGate>
  );
}
