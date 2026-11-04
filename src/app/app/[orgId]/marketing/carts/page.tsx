'use client';

import { CartsCard } from '@/components/carts/carts-card';
import { useCartSettings, useCartSummary } from '@/components/carts/data';
import { CartSettingsCard } from '@/components/carts/settings-card';
import { MarketingHeader } from '@/components/campaigns/marketing-header';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { formatMoney, formatNumber } from '@/lib/format';

/**
 * Marketing › Abandoned carts: the last 30 days in numbers, the reminder settings, and every
 * saved cart with its reminders. Marketing viewers may look; marketing managers change things
 * (the marketing layout checks the role and the plan).
 */
export default function AbandonedCartsPage() {
  const { org, can } = useOrg();
  const editable = can('marketing.manage');
  const settings = useCartSettings(org.id);
  const summary = useCartSummary(org.id);

  const sm = summary.data;
  return (
    <>
      <MarketingHeader />
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
