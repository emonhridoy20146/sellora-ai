'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CreditCard, Wallet } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { GATEWAY_LABEL } from '@/components/billing/labels';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { qk, useBillingSummary } from '@/lib/api/queries';
import type { BillingInterval, Payment, PaymentMethods, Plan } from '@/lib/api/types';
import { formatMoney, formatNumber } from '@/lib/format';
import { cn, randomKey } from '@/lib/utils';

const LIMIT_LABELS: [keyof Plan['limits'], string, string][] = [
  ['seats', 'staff account', 'staff accounts'],
  ['channels', 'connected channel', 'connected channels'],
  ['products', 'product', 'products'],
  ['ordersPerMonth', 'order a month', 'orders a month'],
  ['stores', 'online store', 'online stores'],
];

function limitText(v: number | null, one: string, many: string): string | null {
  if (v === 0) return null;
  if (v === null) return `Unlimited ${many}`;
  return `${formatNumber(v)} ${v === 1 ? one : many}`;
}

const PER: Record<BillingInterval, string> = { month: '/month', year: '/year', lifetime: 'once' };

export default function PlansPage() {
  const { org, can } = useOrg();
  const summary = useBillingSummary(org.id);
  const plans = useQuery({
    queryKey: [...qk.billing(org.id), 'plans'],
    queryFn: () => api<Plan[]>(`/orgs/${org.id}/billing/plans`),
  });
  const [interval, setInterval] = useState<BillingInterval>('month');
  const [chosen, setChosen] = useState<{ plan: Plan; amountMinor: number } | null>(null);

  if (plans.isPending || summary.isPending) return <Skeleton className="h-96" />;
  if (plans.isError) return <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />;
  if (summary.isError)
    return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;

  const currency = summary.data.wallet.currency;
  const sub = summary.data.subscription;
  const intervals = (['month', 'year', 'lifetime'] as const).filter((i) =>
    plans.data.some((p) =>
      p.prices.some((pr) => pr.interval === i && pr.currency === currency && pr.amountMinor > 0),
    ),
  );

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Plans are paid from your wallet. Switching gives back the unused part of your current
          plan.
        </p>
        {intervals.length > 1 && (
          <Segmented
            label="Billing period"
            value={interval}
            onChange={setInterval}
            options={intervals.map((i) => ({
              value: i,
              label: i === 'month' ? 'Monthly' : i === 'year' ? 'Yearly' : 'Lifetime',
            }))}
          />
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {plans.data.map((plan) => {
          const price =
            plan.prices.find((p) => p.currency === currency && p.interval === interval) ??
            (plan.prices.every((p) => p.amountMinor === 0)
              ? plan.prices.find((p) => p.currency === currency)
              : undefined);
          const current =
            sub.plan.code === plan.code && (sub.interval === interval || price?.amountMinor === 0);
          const onTrialOfThis = sub.status === 'trialing' && sub.plan.code === plan.code;
          return (
            <Card
              key={plan.id}
              className={cn(
                'flex flex-col',
                plan.highlight && 'border-primary ring-1 ring-primary/30',
              )}
            >
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>{plan.name}</CardTitle>
                  {current && !onTrialOfThis ? (
                    <Badge tone="success">Current plan</Badge>
                  ) : onTrialOfThis ? (
                    <Badge tone="info">On trial</Badge>
                  ) : plan.highlight ? (
                    <Badge tone="info">Popular</Badge>
                  ) : null}
                </div>
                <p className="min-h-10 text-sm text-muted-foreground">{plan.description}</p>
                <p className="pt-2">
                  {price ? (
                    <>
                      <span className="text-3xl font-semibold tracking-tight">
                        {formatMoney(price.amountMinor, currency)}
                      </span>
                      {price.amountMinor > 0 && (
                        <span className="ml-1 text-sm text-muted-foreground">
                          {PER[price.interval]}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      Not offered{' '}
                      {interval === 'month'
                        ? 'monthly'
                        : interval === 'year'
                          ? 'yearly'
                          : 'as lifetime'}
                    </span>
                  )}
                </p>
              </CardHeader>
              <CardContent className="flex-1">
                <ul className="grid gap-1.5 text-sm">
                  {plan.includedCreditsPerMonth > 0 && (
                    <li className="flex gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                      {formatNumber(plan.includedCreditsPerMonth)} AI credits every month
                    </li>
                  )}
                  {plan.modules.map((m) => (
                    <li key={m.key} className="flex gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                      {m.name}
                    </li>
                  ))}
                  {LIMIT_LABELS.map(([k, one, many]) => {
                    const t = limitText(plan.limits[k], one, many);
                    return t ? (
                      <li key={k} className="flex gap-2 text-muted-foreground">
                        <span className="w-4 shrink-0 text-center" aria-hidden>
                          ·
                        </span>
                        {t}
                      </li>
                    ) : null;
                  })}
                </ul>
              </CardContent>
              <CardFooter>
                {can('billing.manage') && price && (!current || onTrialOfThis) ? (
                  <Button
                    className="w-full"
                    variant={plan.highlight ? 'default' : 'outline'}
                    onClick={() => setChosen({ plan, amountMinor: price.amountMinor })}
                  >
                    {price.amountMinor === 0
                      ? `Move to ${plan.name}`
                      : onTrialOfThis
                        ? 'Keep this plan'
                        : `Choose ${plan.name}`}
                  </Button>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {current ? 'You are on this plan' : ' '}
                  </span>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>
      {chosen && (
        <CheckoutDialog
          orgId={org.id}
          plan={chosen.plan}
          interval={chosen.amountMinor === 0 ? 'month' : interval}
          amountMinor={chosen.amountMinor}
          currency={currency}
          availableMinor={summary.data.wallet.availableMinor - summary.data.wallet.bonusMinor}
          onClose={() => setChosen(null)}
        />
      )}
    </div>
  );
}

function CheckoutDialog({
  orgId,
  plan,
  interval,
  amountMinor,
  currency,
  availableMinor,
  onClose,
}: {
  orgId: string;
  plan: Plan;
  interval: BillingInterval;
  amountMinor: number;
  currency: string;
  availableMinor: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const methods = useQuery({
    queryKey: [...qk.billing(orgId), 'payment-methods'],
    queryFn: () => api<PaymentMethods>(`/orgs/${orgId}/billing/payment-methods`),
  });
  const [key] = useState(randomKey);
  const fromWallet = useMutation({
    mutationFn: () =>
      api(`/orgs/${orgId}/billing/subscription`, { body: { planCode: plan.code, interval } }),
    meta: { silent: true },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.billing(orgId) });
      toast.success(`You are now on ${plan.name}.`);
      onClose();
    },
  });
  const online = useMutation({
    mutationFn: (gateway: string) =>
      api<Payment>(`/orgs/${orgId}/billing/subscription/checkout`, {
        body: { planCode: plan.code, interval, gateway, idempotencyKey: `${key}:${gateway}` },
      }),
    meta: { silent: true },
    onSuccess: (p) => {
      if (p.checkoutUrl) window.location.assign(p.checkoutUrl);
    },
  });
  const enough = availableMinor >= amountMinor;
  const error = fromWallet.error ?? online.error;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={amountMinor === 0 ? `Move to ${plan.name}?` : `Pay for ${plan.name}`}
        description={
          amountMinor === 0
            ? 'Paid features stop now. Any unused paid time goes back to your wallet.'
            : `${formatMoney(amountMinor, currency)} ${PER[interval]}. Unused time on your current paid plan is refunded to your wallet first.`
        }
      >
        <div className="grid gap-3">
          {error && <Alert tone="danger">{errorMessage(error)}</Alert>}
          <button
            type="button"
            disabled={fromWallet.isPending || (!enough && amountMinor > 0)}
            onClick={() => fromWallet.mutate()}
            className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Wallet className="size-5 text-primary" aria-hidden />
            <span className="flex-1">
              <span className="block text-sm font-medium">
                {amountMinor === 0 ? 'Confirm' : 'Pay from wallet'}
              </span>
              {amountMinor > 0 && (
                <span className="block text-[13px] text-muted-foreground">
                  {enough
                    ? `Your money in the wallet: ${formatMoney(availableMinor, currency)}`
                    : `Not enough money in the wallet (${formatMoney(availableMinor, currency)}). Free AI credit cannot pay for plans.`}
                </span>
              )}
            </span>
            {fromWallet.isPending && (
              <span className="size-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            )}
          </button>
          {amountMinor > 0 &&
            methods.data?.online.map((g) => (
              <button
                key={g.key}
                type="button"
                disabled={online.isPending}
                onClick={() => online.mutate(g.key)}
                className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent/40 disabled:opacity-60"
              >
                <CreditCard className="size-5 text-primary" aria-hidden />
                <span className="flex-1">
                  <span className="block text-sm font-medium">{GATEWAY_LABEL[g.key] ?? g.key}</span>
                  <span className="block text-[13px] text-muted-foreground">
                    You will be sent to a secure payment page{g.sandbox ? ' (test mode)' : ''}.
                  </span>
                </span>
                {online.isPending && online.variables === g.key && (
                  <span className="size-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                )}
              </button>
            ))}
          {amountMinor > 0 && !enough && methods.data && methods.data.online.length === 0 && (
            <p className="text-[13px] text-muted-foreground">
              Top up your wallet first (bank or mobile transfer), then come back.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
