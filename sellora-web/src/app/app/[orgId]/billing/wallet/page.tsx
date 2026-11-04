'use client';

import { LedgerTable } from '@/components/billing/ledger-table';
import { PaymentsTable } from '@/components/billing/payments-table';
import { TopupCard } from '@/components/billing/topup-card';
import { WithdrawalsCard } from '@/components/billing/withdrawals-card';
import { useOrg } from '@/components/org-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { useBillingSummary } from '@/lib/api/queries';
import { formatMoney } from '@/lib/format';

export default function WalletPage() {
  const { org, can } = useOrg();
  const q = useBillingSummary(org.id);
  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const w = q.data.wallet;

  return (
    <div className="grid gap-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Available"
          value={formatMoney(w.availableMinor, w.currency)}
          sub="Money plus free credit, minus holds"
        />
        <Stat
          label="Free AI credit"
          value={formatMoney(w.bonusMinor, w.currency)}
          sub="Used first, for AI only"
        />
        <Stat
          label="Added so far"
          value={formatMoney(w.lifetimeTopupMinor, w.currency)}
          sub={`Spent ${formatMoney(w.lifetimeSpentMinor, w.currency)}`}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          {can('billing.manage') ? <TopupCard orgId={org.id} /> : null}
        </div>
        <Card className={can('billing.manage') ? 'lg:col-span-3' : 'lg:col-span-5'}>
          <CardHeader>
            <CardTitle>Payments</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <PaymentsTable orgId={org.id} timeZone={org.timezone} />
          </CardContent>
        </Card>
      </div>
      {q.data.withdrawalsEnabled && (
        <WithdrawalsCard orgId={org.id} wallet={w} canManage={can('billing.manage')} />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Wallet activity</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <LedgerTable orgId={org.id} currency={w.currency} timeZone={org.timezone} />
        </CardContent>
      </Card>
    </div>
  );
}
