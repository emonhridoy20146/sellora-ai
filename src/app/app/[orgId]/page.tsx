'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Circle, Clock } from 'lucide-react';
import Link from 'next/link';
import { UsageChart } from '@/components/billing/usage-chart';
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
import { useBillingSummary, useMe } from '@/lib/api/queries';
import type { Member, UsageSummary } from '@/lib/api/types';
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
  const { org, can } = useOrg();
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
  const upcoming = [
    'Connect Facebook, Instagram and WhatsApp',
    'Add your products and stock',
    'Turn on the AI sales agent',
  ];

  return (
    <>
      <PageHeader
        title={`${greeting(org.timezone)}, ${user.name.split(' ')[0]}`}
        description={`Here is how ${org.name} is doing.`}
      />

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
