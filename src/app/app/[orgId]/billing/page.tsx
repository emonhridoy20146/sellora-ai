'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Sparkles, Wallet } from 'lucide-react';
import Link from 'next/link';
import { INTERVAL_LABEL, TIER_LABEL } from '@/components/billing/labels';
import { LedgerTable } from '@/components/billing/ledger-table';
import { SubscriptionActions } from '@/components/billing/subscription-actions';
import { useOrg } from '@/components/org-context';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { useBillingSummary } from '@/lib/api/queries';
import { daysUntil, formatDate, formatMoney, formatNumber, formatStorage } from '@/lib/format';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

export default function BillingOverviewPage() {
  const { org, can } = useOrg();
  const q = useBillingSummary(org.id);
  const storage = useQuery({
    queryKey: ['org', org.id, 'files', 'usage'],
    queryFn: () =>
      api<{ usedBytes: number; limitBytes: number | null }>(`/orgs/${org.id}/files/usage`),
  });
  const base = `/app/${org.id}/billing`;
  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const { subscription: s, wallet: w, creditRate: rate } = q.data;
  const trialLeft = daysUntil(s.trialEndsAt);

  return (
    <div className="grid gap-6">
      {s.entitlements.inGracePeriod && (
        <Alert tone="warning" title="Your plan payment is overdue">
          Features stay on for a few more days. Add money to your wallet and the plan renews
          automatically.
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Current plan</CardDescription>
            <CardTitle className="flex items-center gap-2 text-xl">
              {s.plan.name} <StatusBadge status={s.status} />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <Row label="Billing">
                {INTERVAL_LABEL[s.interval] ?? s.interval}
                {s.priceMinor > 0 && ` · ${formatMoney(s.priceMinor, s.currency)}`}
              </Row>
              {s.status === 'trialing' ? (
                <Row label="Trial ends">
                  {formatDate(s.trialEndsAt, org.timezone)}
                  {trialLeft !== null && ` (${Math.max(0, trialLeft)} days left)`}
                </Row>
              ) : (
                s.currentPeriodEnd && (
                  <Row label={s.cancelAtPeriodEnd ? 'Ends on' : 'Renews on'}>
                    {formatDate(s.currentPeriodEnd, org.timezone)}
                  </Row>
                )
              )}
              <Row label="AI credits included">
                {s.includedCreditsPerMonth > 0
                  ? `${formatNumber(s.includedCreditsPerMonth)} ${s.status === 'trialing' ? 'for the trial' : 'per month'}`
                  : 'None'}
              </Row>
              {s.nextCreditGrantAt && (
                <Row label="Next free credits">{formatDate(s.nextCreditGrantAt, org.timezone)}</Row>
              )}
              {storage.data && (
                <Row label="File storage">
                  {storage.data.limitBytes === null
                    ? `${formatStorage(storage.data.usedBytes)} used`
                    : `${formatStorage(storage.data.usedBytes)} of ${formatStorage(storage.data.limitBytes)}`}
                </Row>
              )}
            </dl>
            {storage.data?.limitBytes ? (
              <div
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label="File storage used"
                aria-valuemin={0}
                aria-valuemax={storage.data.limitBytes}
                aria-valuenow={storage.data.usedBytes}
              >
                <div
                  className={
                    storage.data.usedBytes / storage.data.limitBytes > 0.9
                      ? 'h-full rounded-full bg-warning'
                      : 'h-full rounded-full bg-primary'
                  }
                  style={{
                    width: `${Math.min(100, Math.max(1, (storage.data.usedBytes / storage.data.limitBytes) * 100))}%`,
                  }}
                />
              </div>
            ) : null}
            {s.cancelAtPeriodEnd && (
              <Alert tone="info" className="mt-3">
                This plan will not renew. The business moves to Free on{' '}
                {formatDate(s.currentPeriodEnd)}.
              </Alert>
            )}
          </CardContent>
          <CardFooter className="justify-between">
            {can('billing.manage') ? (
              <>
                <Button asChild size="sm">
                  <Link href={`${base}/plans`}>
                    {s.status === 'trialing' ? 'Choose a plan' : 'Change plan'}
                  </Link>
                </Button>
                <SubscriptionActions orgId={org.id} sub={s} />
              </>
            ) : (
              <span className="text-muted-foreground">
                Only the owner and billing managers can change the plan.
              </span>
            )}
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Wallet</CardDescription>
            <CardTitle className="text-xl">{formatMoney(w.availableMinor, w.currency)}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <Row label="Your money">
                {formatMoney(Math.max(0, w.availableMinor - w.bonusMinor), w.currency)}
              </Row>
              <Row label="Free AI credit">
                <span className="inline-flex items-center gap-1">
                  <Sparkles className="size-3.5 text-primary" aria-hidden />
                  {formatMoney(w.bonusMinor, w.currency)}
                </span>
              </Row>
              {w.heldMinor > 0 && (
                <Row label="On hold (AI replies in progress, withdrawals)">
                  {formatMoney(w.heldMinor, w.currency)}
                </Row>
              )}
              <Row label="Spent so far">{formatMoney(w.lifetimeSpentMinor, w.currency)}</Row>
            </dl>
            {w.status === 'frozen' && (
              <Alert tone="danger" className="mt-3">
                This wallet is frozen. Contact support.
              </Alert>
            )}
          </CardContent>
          <CardFooter>
            {can('billing.manage') && (
              <Button asChild size="sm">
                <Link href={`${base}/wallet`}>
                  <Wallet /> Top up
                </Link>
              </Button>
            )}
            <Button asChild size="sm" variant="ghost">
              <Link href={`${base}/usage`}>
                AI usage <ArrowRight />
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </div>

      {rate && (
        <Card>
          <CardHeader>
            <CardTitle>How AI credits are counted</CardTitle>
            <CardDescription>
              1 credit costs {formatMoney(rate.creditPriceMinor, rate.currency)}. Each AI request
              uses credits for the text it reads and the text it writes, measured per 1,000 tokens
              (about 750 English words). The smallest charge is{' '}
              {formatNumber(rate.minimumCreditsPerRequest)} credit per request. Free credit is used
              first.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            <Table>
              <THead>
                <TR>
                  <TH>AI level</TH>
                  <TH className="text-right">Reading, per 1K tokens</TH>
                  <TH className="text-right">Writing, per 1K tokens</TH>
                </TR>
              </THead>
              <TBody>
                {rate.tiers.map((t) => (
                  <TR key={t.tier}>
                    <TD>
                      <span className="block font-medium">{TIER_LABEL[t.tier].name}</span>
                      <span className="text-xs text-muted-foreground">
                        {TIER_LABEL[t.tier].use}
                      </span>
                    </TD>
                    <TD className="tabular text-right">
                      {formatNumber(t.inputCreditsPer1k)} credits
                    </TD>
                    <TD className="tabular text-right">
                      {formatNumber(t.outputCreditsPer1k)} credits
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent wallet activity</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <LedgerTable
            orgId={org.id}
            currency={w.currency}
            timeZone={org.timezone}
            limit={8}
            filter={false}
            paginate={false}
          />
        </CardContent>
        <CardFooter>
          <Button asChild variant="link" size="sm">
            <Link href={`${base}/wallet`}>
              All activity <ArrowRight />
            </Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
