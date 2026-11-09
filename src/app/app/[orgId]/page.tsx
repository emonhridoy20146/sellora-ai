'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Circle, Clock } from 'lucide-react';
import Link from 'next/link';
import { useAnalytics, ValueTiles } from '@/components/analytics/value-tiles';
import { UsageChart } from '@/components/billing/usage-chart';
import { commerceKeys, useShopSettings } from '@/components/commerce/hooks';
import { useCourierChoices } from '@/components/couriers/data';
import { useChannels } from '@/components/inbox/data';
import { useOrg } from '@/components/org-context';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { useBillingSummary, useMe } from '@/lib/api/queries';
import type { AiAgentView, Member, OrdersSummary, UsageSummary } from '@/lib/api/types';
import { daysUntil, formatDate, formatMoney, formatNumber } from '@/lib/format';
import { rangeFromDays } from '@/lib/series';

function greeting(timeZone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone }).format(
      new Date(),
    ),
  );
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function OverviewPage() {
  const { org, can, modules } = useOrg();
  const me = useMe();
  const billing = useBillingSummary(org.id, can('billing.view'));
  const range = rangeFromDays(14);
  const usage = useQuery({
    queryKey: ['org', org.id, 'billing', 'usage', 14],
    queryFn: () => api<UsageSummary>(`/orgs/${org.id}/billing/ai-usage`, { query: range }),
    enabled: can('billing.view'),
  });
  const members = useQuery({
    queryKey: ['org', org.id, 'members'],
    queryFn: () => api<Member[]>(`/orgs/${org.id}/members`),
    enabled: can('org.members.view'),
  });
  const orders = useQuery({
    queryKey: commerceKeys.summary(org.id),
    queryFn: () => api<OrdersSummary>(`/orgs/${org.id}/orders/summary`),
    enabled: can('orders.view'),
  });
  // Plans without the commerce module answer 402; the overview then leaves orders out.
  const commerceOff =
    orders.error instanceof ApiError && orders.error.code === 'module_not_in_plan';
  const shop = useShopSettings(org.id, can('org.settings.manage') && !commerceOff);
  const inboxInPlan = modules === null || modules.includes('inbox');
  const channels = useChannels(org.id, can('org.integrations.manage') && inboxInPlan);
  const aiInPlan = modules === null || modules.includes('ai_agent');
  const couriersInPlan = modules === null || modules.includes('couriers');
  const couriers = useCourierChoices(
    org.id,
    can('org.integrations.manage') && couriersInPlan && !commerceOff,
  );
  const agent = useQuery({
    queryKey: ['org', org.id, 'ai-agent'],
    queryFn: () => api<AiAgentView>(`/orgs/${org.id}/ai-agent`),
    enabled: can('ai.settings.manage') && aiInPlan,
  });
  const analyticsInPlan = modules === null || modules.includes('analytics');
  const value = useAnalytics(org.id, 30, can('analytics.view') && analyticsInPlan);
  const user = me.data!.user;
  const b = billing.data;
  const s = b?.subscription;
  const base = `/app/${org.id}`;

  const steps = [
    {
      done: user.emailVerified,
      label: 'Verify your email',
      href: null,
      note: `Check ${user.email}`,
    },
    {
      done: user.mfaEnabled,
      label: 'Turn on two-step verification',
      href: '/app/account',
      note: 'Protects your shop if your password leaks',
    },
    ...(can('catalog.manage') && orders.data
      ? [
          {
            done: orders.data.products.active > 0,
            label: 'Add your products',
            href: `${base}/products/new`,
            note: 'With prices, sizes and stock, so orders count stock for you',
          },
        ]
      : []),
    ...(can('org.settings.manage') && shop.data
      ? [
          {
            done: shop.data.deliveryZones.length > 0,
            label: 'Set your delivery charges',
            href: `${base}/settings/selling`,
            note: 'For example Inside Dhaka and Outside Dhaka',
          },
        ]
      : []),
    ...(channels.data
      ? [
          {
            done: channels.data.length > 0,
            label: 'Connect where customers message you',
            href: `${base}/settings/channels`,
            note: 'Website chat, Facebook page, Instagram or WhatsApp',
          },
        ]
      : []),
    ...(couriers.data
      ? [
          {
            done: couriers.data.length > 0,
            label: 'Connect a courier',
            href: `${base}/settings/couriers`,
            note: 'Steadfast, Pathao or RedX: book and track parcels from your orders',
          },
        ]
      : []),
    ...(agent.data
      ? [
          {
            done: agent.data.settings.enabled,
            label: 'Turn on the AI sales agent',
            href: `${base}/ai-agent`,
            note: 'It answers customers and takes orders while you are busy',
          },
        ]
      : []),
    ...(can('org.members.manage')
      ? [
          {
            done: (members.data?.length ?? 1) > 1,
            label: 'Invite your team',
            href: `${base}/staff`,
            note: 'Give each person only the access they need',
          },
        ]
      : []),
    ...(can('billing.manage')
      ? [
          {
            done: (b?.wallet.lifetimeTopupMinor ?? 0) > 0,
            label: 'Add money to your wallet',
            href: `${base}/billing/wallet`,
            note: 'Pays for AI replies after your free credits',
          },
        ]
      : []),
  ];
  /** Setup steps for features still being built (none right now). */
  const upcoming: string[] = [];
  const o = orders.data;
  const toHandle = o ? o.toHandle.pending + o.toHandle.confirmed + o.toHandle.packed : 0;
  const ordersLink = (status: string, text: string) => (
    <Link
      href={`${base}/orders?status=${status}`}
      className="hover:text-foreground hover:underline"
    >
      {text}
    </Link>
  );

  return (
    <>
      <PageHeader
        title={`${greeting(org.timezone)}, ${user.name.split(' ')[0]}`}
        description={`Here is how ${org.name} is doing.`}
      />

      {value.data &&
        (value.data.value.ai || value.data.value.carts || value.data.value.riskyOrders) && (
          <section aria-labelledby="value-heading" className="mb-6">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 id="value-heading" className="text-sm font-medium">
                What Sellora did for you in the last 30 days
              </h2>
              <Link href={`${base}/analytics`} className="text-[13px] text-primary hover:underline">
                Analytics
              </Link>
            </div>
            <ValueTiles o={value.data} compact />
          </section>
        )}

      {can('orders.view') && !commerceOff && (
        <section aria-labelledby="orders-heading" className="mb-6">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 id="orders-heading" className="text-sm font-medium">
              Orders
            </h2>
            <Link href={`${base}/orders`} className="text-[13px] text-primary hover:underline">
              All orders
            </Link>
          </div>
          {orders.isError ? (
            <Alert
              tone="danger"
              action={
                <Button size="sm" variant="outline" onClick={() => void orders.refetch()}>
                  Try again
                </Button>
              }
            >
              Could not load your order numbers.
            </Alert>
          ) : !o ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-[104px]" />
              ))}
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Orders today"
                  value={formatNumber(o.today.orders)}
                  sub={`${formatMoney(o.today.valueMinor, o.currency)} order value`}
                />
                <Stat
                  label="Order value this month"
                  value={formatMoney(o.month.valueMinor, o.currency)}
                  sub={`${formatNumber(o.month.orders)} orders, without cancelled or returned`}
                />
                <Stat
                  label="Orders to handle"
                  value={formatNumber(toHandle)}
                  sub={
                    <>
                      {ordersLink('pending', `${o.toHandle.pending} to confirm`)} ·{' '}
                      {ordersLink('confirmed', `${o.toHandle.confirmed} to pack`)} ·{' '}
                      {ordersLink('packed', `${o.toHandle.packed} to ship`)}
                    </>
                  }
                />
                <Stat
                  label="Cash to collect"
                  value={formatMoney(o.shipped.toCollectMinor, o.currency)}
                  sub={ordersLink(
                    'shipped',
                    `on ${formatNumber(o.shipped.orders)} shipped ${o.shipped.orders === 1 ? 'order' : 'orders'}`,
                  )}
                />
              </div>
              {o.products.lowStock > 0 && can('catalog.view') && (
                <Alert
                  tone="warning"
                  className="mt-3"
                  action={
                    <Button asChild size="sm" variant="outline" className="bg-background">
                      <Link href={`${base}/products?stock=low`}>See products</Link>
                    </Button>
                  }
                >
                  {o.products.lowStock === 1
                    ? '1 product is running low on stock.'
                    : `${formatNumber(o.products.lowStock)} products are running low on stock.`}
                </Alert>
              )}
            </>
          )}
        </section>
      )}

      {can('billing.view') && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {!b ? (
            Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[104px]" />)
          ) : (
            <>
              <Stat
                label="Plan"
                value={s!.plan.name}
                sub={
                  s!.status === 'trialing' ? (
                    <span className="inline-flex items-center gap-1.5">
                      <StatusBadge status="trialing" /> ends {formatDate(s!.trialEndsAt)} (
                      {Math.max(0, daysUntil(s!.trialEndsAt) ?? 0)} days)
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <StatusBadge status={s!.status} />
                      {s!.currentPeriodEnd && `renews ${formatDate(s!.currentPeriodEnd)}`}
                    </span>
                  )
                }
              />
              <Stat
                label="Wallet balance"
                value={formatMoney(b.wallet.availableMinor, b.wallet.currency)}
                sub={
                  b.wallet.bonusMinor > 0
                    ? `includes ${formatMoney(b.wallet.bonusMinor, b.wallet.currency)} free AI credit`
                    : 'available to spend'
                }
              />
              <Stat
                label="AI credits used · 14 days"
                value={usage.data ? formatNumber(usage.data.totals.credits, { digits: 0 }) : '–'}
                sub={
                  usage.data
                    ? `${formatMoney(usage.data.totals.chargedMinor, b.wallet.currency)} charged`
                    : ' '
                }
              />
              <Stat
                label="AI requests · 14 days"
                value={usage.data ? formatNumber(usage.data.totals.requests) : '–'}
                sub={
                  b.creditRate
                    ? `1 credit = ${formatMoney(b.creditRate.creditPriceMinor, b.creditRate.currency)}`
                    : ' '
                }
              />
            </>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>AI credits per day</CardTitle>
            <CardDescription>
              Last 14 days, in {org.timezone.replaceAll('_', ' ')} time
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!can('billing.view') ? (
              <p className="text-sm text-muted-foreground">Your role cannot see billing.</p>
            ) : usage.data ? (
              usage.data.totals.requests === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No AI usage yet. Credits are used when the AI writes replies or product text.
                </p>
              ) : (
                <UsageChart summary={usage.data} timeZone={org.timezone} height={200} />
              )
            ) : (
              <Skeleton className="h-[230px]" />
            )}
            {can('billing.view') && (
              <Button asChild variant="link" size="sm" className="mt-2">
                <Link href={`${base}/billing/usage`}>
                  See usage details <ArrowRight />
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Get set up</CardTitle>
            <CardDescription>
              {steps.filter((x) => x.done).length} of {steps.length} done
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1">
              {steps.map((step) => {
                const body = (
                  <>
                    {step.done ? (
                      <Check className="size-4 text-success" aria-hidden />
                    ) : (
                      <Circle className="size-4 text-muted-foreground" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className={step.done ? 'text-muted-foreground line-through' : 'font-medium'}
                      >
                        {step.label}
                      </span>
                      {!step.done && (
                        <span className="block text-[13px] text-muted-foreground">{step.note}</span>
                      )}
                    </span>
                    <span className="sr-only">{step.done ? 'done' : 'to do'}</span>
                  </>
                );
                return (
                  <li key={step.label}>
                    {step.href && !step.done ? (
                      <Link
                        href={step.href}
                        className="flex items-start gap-3 rounded-md p-2 text-sm hover:bg-accent"
                      >
                        {body}
                      </Link>
                    ) : (
                      <div className="flex items-start gap-3 p-2 text-sm">{body}</div>
                    )}
                  </li>
                );
              })}
              {upcoming.map((label) => (
                <li
                  key={label}
                  className="flex items-start gap-3 p-2 text-sm text-muted-foreground"
                >
                  <Clock className="size-4" aria-hidden />
                  <span className="flex-1">{label}</span>
                  <Badge tone="outline">Coming soon</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {!user.emailVerified && (
        <Alert tone="warning" title="Your email is not verified" className="mt-6">
          You need a verified email to invite staff and to take payments. We sent a link to{' '}
          {user.email}.
        </Alert>
      )}
    </>
  );
}
