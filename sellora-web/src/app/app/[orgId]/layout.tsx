'use client';

import {
  Activity,
  BarChart3,
  Bot,
  Check,
  ChevronsUpDown,
  CreditCard,
  Inbox,
  LayoutDashboard,
  Megaphone,
  Package,
  PanelsTopLeft,
  Plus,
  Settings,
  ShoppingBag,
  Store,
  Truck,
  Users,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { Brand } from '@/components/brand';
import { AppShell, type NavSection } from '@/components/layout/app-shell';
import { UserMenu, merchantMenuLinks } from '@/components/layout/user-menu';
import { OrgProvider } from '@/components/org-context';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { daysUntil, formatDate } from '@/lib/format';
import { useBillingSummary, useMe } from '@/lib/api/queries';
import type { BillingSummary, OrgWithRole } from '@/lib/api/types';

function nav(orgId: string, can: (p: string) => boolean): NavSection[] {
  const base = `/app/${orgId}`;
  const workspace: NavSection = {
    items: [
      { href: base, label: 'Overview', icon: LayoutDashboard, exact: true },
      // Items marked soon are built in later milestones; listed so the roadmap is visible,
      // never clickable yet.
      ...(can('inbox.view') || can('inbox.view_assigned')
        ? [{ href: `${base}/inbox`, label: 'Inbox', icon: Inbox }]
        : []),
      ...(can('ai.settings.manage') || can('ai.knowledge.manage')
        ? [{ href: `${base}/ai-agent`, label: 'AI sales agent', icon: Bot }]
        : []),
      ...(can('orders.view')
        ? [{ href: `${base}/orders`, label: 'Orders', icon: ShoppingBag }]
        : []),
      ...(can('catalog.view')
        ? [{ href: `${base}/products`, label: 'Products', icon: Package }]
        : []),
      ...(can('customers.view')
        ? [{ href: `${base}/customers`, label: 'Customers', icon: UserRound }]
        : []),
      ...(can('orders.view') ? [{ href: `${base}/couriers`, label: 'Couriers', icon: Truck }] : []),
      ...(can('stores.view')
        ? [
            { href: `${base}/store`, label: 'Online store', icon: Store },
            { href: `${base}/landing-pages`, label: 'Landing pages', icon: PanelsTopLeft },
          ]
        : []),
      ...(can('marketing.view') || can('marketing.manage')
        ? [{ href: `${base}/marketing`, label: 'Marketing', icon: Megaphone }]
        : []),
      ...(can('analytics.view')
        ? [{ href: `${base}/analytics`, label: 'Analytics', icon: BarChart3 }]
        : []),
    ],
  };
  const manage: NavSection = { label: 'Manage', items: [] };
  if (can('billing.view'))
    manage.items.push({ href: `${base}/billing`, label: 'Billing & credits', icon: CreditCard });
  if (can('org.members.view'))
    manage.items.push({ href: `${base}/staff`, label: 'Staff', icon: Users });
  manage.items.push({ href: `${base}/settings`, label: 'Settings', icon: Settings });
  if (can('org.audit.view'))
    manage.items.push({ href: `${base}/activity`, label: 'Activity log', icon: Activity });
  return [workspace, manage];
}

function OrgSwitcher({ org, orgs }: { org: OrgWithRole; orgs: OrgWithRole[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-auto w-full justify-between px-3 py-2 text-left">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{org.name}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {org.role.name}
            </span>
          </span>
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Businesses</DropdownMenuLabel>
        {orgs.map((o) => (
          <DropdownMenuItem key={o.id} asChild>
            <Link href={`/app/${o.id}`}>
              <Store />
              <span className="flex-1 truncate">{o.name}</span>
              {o.id === org.id && <Check className="text-primary" />}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/app?choose=1">
            <Plus />
            Add business
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Banner({ org, billing }: { org: OrgWithRole; billing: BillingSummary | undefined }) {
  const base = `/app/${org.id}/billing`;
  let tone = '';
  let text: React.ReactNode = null;
  if (org.status === 'suspended') {
    tone = 'bg-danger-soft text-destructive';
    text = 'This business is suspended by the platform. Contact support to restore access.';
  } else if (billing) {
    const s = billing.subscription;
    const left = daysUntil(s.trialEndsAt);
    if (s.status === 'past_due') {
      tone = 'bg-warning-soft text-warning';
      text = (
        <>
          Your {s.plan.name} plan payment is due. Add money to your wallet before{' '}
          {formatDate(s.currentPeriodEnd)} to keep every feature.{' '}
          <Link href={`${base}/wallet`} className="font-medium underline">
            Top up
          </Link>
        </>
      );
    } else if (s.status === 'trialing' && left !== null && left <= 3) {
      tone = 'bg-info-soft text-primary';
      text = (
        <>
          Your free trial ends {left <= 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`}.{' '}
          <Link href={`${base}/plans`} className="font-medium underline">
            Choose a plan
          </Link>
        </>
      );
    } else if (billing.wallet.status === 'frozen') {
      tone = 'bg-danger-soft text-destructive';
      text =
        'Your wallet is frozen. AI replies and payments from the wallet are paused. Contact support.';
    }
  }
  if (!text) return null;
  return <div className={`border-b px-4 py-2 text-center text-sm sm:px-6 ${tone}`}>{text}</div>;
}

export default function OrgLayout({ children }: { children: React.ReactNode }) {
  const { orgId } = useParams<{ orgId: string }>();
  const pathname = usePathname();
  const me = useMe();
  const org = me.data?.organizations.find((o) => o.id === orgId);
  const can = useMemo(() => {
    const set = new Set(org?.permissions ?? []);
    return (p: string) => set.has(p);
  }, [org]);
  const billing = useBillingSummary(orgId, Boolean(org) && can('billing.view'));

  if (!me.data) return null;
  if (!org) {
    return (
      <div className="pt-24">
        <EmptyState
          icon={Store}
          title="You do not have access to this business"
          action={
            <Button asChild>
              <Link href="/app?choose=1">See your businesses</Link>
            </Button>
          }
        >
          It may have been removed, or your access was changed.
        </EmptyState>
      </div>
    );
  }

  return (
    <OrgProvider
      value={{ org, can, modules: billing.data?.subscription.entitlements.modules ?? null }}
    >
      <AppShell
        brand={<Brand href={`/app/${org.id}`} />}
        switcher={<OrgSwitcher org={org} orgs={me.data.organizations} />}
        sections={nav(org.id, can)}
        banner={<Banner org={org} billing={billing.data} />}
        fullBleed={pathname === `/app/${org.id}/inbox`}
        topRight={
          <>
            <ThemeToggle />
            <UserMenu
              realm="merchant"
              name={me.data.user.name}
              email={me.data.user.email}
              links={merchantMenuLinks}
            />
          </>
        }
      >
        {children}
      </AppShell>
    </OrgProvider>
  );
}
