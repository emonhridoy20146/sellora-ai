'use client';

import { Check } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { LIVE_MODULES } from '@/config/marketing';
import type { Plan, PlanLimits } from '@/lib/api/types';
import { formatMoney, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

const LIMIT_COPY: Partial<Record<keyof PlanLimits, (n: number) => string>> = {
  seats: (n) => `${n} staff seat${n === 1 ? '' : 's'}`,
  channels: (n) => `${n} connected page${n === 1 ? '' : 's'} or number${n === 1 ? '' : 's'}`,
  conversationsPerMonth: (n) => `${formatNumber(n)} conversations a month`,
  ordersPerMonth: (n) => `${formatNumber(n)} orders a month`,
  products: (n) => `${formatNumber(n)} products`,
};

const UNLIMITED_COPY: Partial<Record<keyof PlanLimits, string>> = {
  seats: 'Unlimited staff',
  conversationsPerMonth: 'Unlimited conversations',
  ordersPerMonth: 'Unlimited orders',
};

/** Plans from the API, with a monthly/yearly switch. Prices shown are exactly what checkout charges. */
export function Pricing({ plans, trialDays }: { plans: Plan[]; trialDays: number | null }) {
  const hasYearly = plans.some((p) => p.prices.some((x) => x.interval === 'year'));
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const sorted = [...plans].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div>
      {hasYearly && (
        <div className="mb-8 flex justify-center">
          <Segmented
            label="Billing period"
            value={interval}
            onChange={setInterval}
            options={[
              { value: 'month', label: 'Monthly' },
              { value: 'year', label: 'Yearly' },
            ]}
          />
        </div>
      )}
      <div
        className={cn(
          'grid gap-4 md:grid-cols-2',
          sorted.length === 3 && 'lg:grid-cols-3',
          sorted.length === 4 && 'xl:grid-cols-4',
          sorted.length >= 5 && 'lg:grid-cols-3 xl:grid-cols-5',
        )}
      >
        {sorted.map((p) => {
          const price =
            p.prices.find((x) => x.interval === interval) ??
            p.prices.find((x) => x.interval === 'month');
          const free = !price || price.amountMinor === 0;
          const monthlyEquivalent =
            price?.interval === 'year' && price.amountMinor > 0
              ? Math.round(price.amountMinor / 12)
              : null;
          const limits = (Object.keys(LIMIT_COPY) as (keyof PlanLimits)[])
            .map((k) => {
              const v = p.limits[k];
              if (v === null) return UNLIMITED_COPY[k] ?? null;
              if (v === 0) return null;
              return LIMIT_COPY[k]!(v);
            })
            .filter(Boolean) as string[];
          return (
            <div
              key={p.id}
              className={cn(
                'relative flex flex-col rounded-xl border bg-card p-6 shadow-xs',
                p.highlight && 'border-primary shadow-md ring-1 ring-primary/30',
              )}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-6 rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground">
                  Most popular
                </span>
              )}
              <h3 className="text-lg font-semibold">{p.name}</h3>
              <p className="mt-1 min-h-10 text-sm text-muted-foreground">{p.description}</p>
              <p className="mt-5">
                <span className="text-3xl font-semibold tracking-tight">
                  {free ? 'Free' : formatMoney(price.amountMinor, price.currency)}
                </span>
                {!free && (
                  <span className="text-sm text-muted-foreground">
                    {' '}
                    / {price.interval === 'year' ? 'year' : 'month'}
                  </span>
                )}
              </p>
              <p className="mt-1 h-5 text-xs text-muted-foreground">
                {monthlyEquivalent !== null && price
                  ? `${formatMoney(monthlyEquivalent, price.currency)} a month, billed yearly`
                  : ''}
              </p>
              <Button asChild className="mt-5" variant={p.highlight ? 'default' : 'outline'}>
                <Link href={`/signup?plan=${encodeURIComponent(p.code)}`}>
                  {p.trialEligible && trialDays
                    ? `Try free for ${trialDays} days`
                    : free
                      ? 'Start free'
                      : 'Get started'}
                </Link>
              </Button>
              <ul className="mt-6 space-y-2 text-sm">
                {p.includedCreditsPerMonth > 0 && (
                  <li className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    {formatNumber(p.includedCreditsPerMonth)} free AI credits every month
                  </li>
                )}
                {limits.map((l) => (
                  <li key={l} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    {l}
                  </li>
                ))}
                {p.modules.map((m) => (
                  <li key={m.key} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    <span>
                      {m.name}
                      {!LIVE_MODULES.includes(m.key) && (
                        <span className="ml-1.5 text-xs whitespace-nowrap text-muted-foreground">
                          coming soon
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
