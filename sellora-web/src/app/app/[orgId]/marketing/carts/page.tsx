'use client';

import { Lock, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { CartsCard } from '@/components/carts/carts-card';
import { useCartSettings, useCartSummary } from '@/components/carts/data';
import { CartSettingsCard } from '@/components/carts/settings-card';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { formatMoney, formatNumber } from '@/lib/format';

/**
 * Marketing › Abandoned carts: the last 30 days in numbers, the reminder settings, and every
 * saved cart with its reminders. Marketing viewers may look; marketing managers change things.
 */
export default function AbandonedCartsPage() {
  const { org, can, modules } = useOrg();
  const editable = can('marketing.manage');
  const visible = editable || can('marketing.view');
  const inPlan = modules === null || modules.includes('marketing');
  const settings = useCartSettings(org.id, visible && inPlan);
  const summary = useCartSummary(org.id, visible && inPlan);

  if (!visible)
    return (
      <EmptyState icon={ShoppingCart} title="Your role does not include marketing">
        Ask the business owner to give your role access to marketing.
      </EmptyState>
    );
  if (!inPlan)
    return (
      <EmptyState
        icon={Lock}
        title="Abandoned cart reminders are not in your plan"
        action={
          can('billing.view') && (
            <Button asChild>
              <Link href={`/app/${org.id}/billing/plans`}>See plans</Link>
            </Button>
          )
        }
      >
        Upgrade to text shoppers who leave a phone number but do not order, with a link back to
        their cart.
      </EmptyState>
    );

  const sm = summary.data;
  return (
    <>
      <PageHeader
        title="Abandoned carts"
        description="Shoppers who typed a phone number and left without ordering, and the reminders that bring them back."
      />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Carts left, 30 days"
          value={sm ? formatNumber(sm.left) : '…'}
          sub={
            sm
              ? `${formatNumber(sm.open)} still open · ${formatMoney(sm.openMinor, sm.currency)}`
              : undefined
          }
        />
        <Stat
          label="Reminded"
          value={sm ? formatNumber(sm.reminded) : '…'}
          sub={sm ? `${formatNumber(sm.clicked)} opened the link` : undefined}
        />
        <Stat
          label="Recovered"
          value={sm ? formatNumber(sm.recovered) : '…'}
          sub={
            sm
              ? `${formatMoney(sm.recoveredMinor, sm.currency)} in orders${sm.recoveryRate !== null ? ` · ${Math.round(sm.recoveryRate * 100)}% of reminded` : ''}`
              : undefined
          }
        />
        <Stat
          label="Reminder SMS"
          value={sm ? formatNumber(sm.smsSent) : '…'}
          sub={
            sm
              ? sm.smsSpentMinor > 0
                ? `${formatMoney(sm.smsSpentMinor, sm.currency)} from your wallet`
                : 'Nothing charged by Sellora'
              : undefined
          }
        />
      </div>
      <div className="grid gap-6">
        {settings.isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : settings.isError ? (
          <PageError error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <CartSettingsCard s={settings.data} editable={editable} />
        )}
        <CartsCard summary={sm} editable={editable} />
      </div>
    </>
  );
}
