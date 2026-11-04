'use client';

import Link from 'next/link';
import { useOrg } from '@/components/org-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { RISK } from '@/lib/couriers';
import { RiskBadge } from './badges';
import { useFraudCheck } from './data';

/** Whether the person can see delivery risk at all (plan and role). */
export function useRiskVisible(): boolean {
  const { can, modules } = useOrg();
  return (
    (modules === null || modules.includes('fraud')) && (can('orders.view') || can('customers.view'))
  );
}

/** Delivery risk for a phone number: this shop's history, plus other shops' when shared. */
export function RiskCard({ phone }: { phone: string | null }) {
  const { org, can } = useOrg();
  const visible = useRiskVisible();
  const q = useFraudCheck(org.id, phone, visible);
  if (!visible || !phone) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delivery risk</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {q.isPending ? (
          <Skeleton className="h-16" />
        ) : q.isError ? (
          <p className="text-muted-foreground">Could not check this number right now.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <RiskBadge level={q.data.level} successRate={q.data.successRate} />
            </div>
            <p className="text-muted-foreground">{RISK[q.data.level].hint}</p>
            <ul className="grid gap-1">
              {q.data.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {q.data.networkStatus === 'not_sharing' && can('org.integrations.manage') && (
              <p className="text-[13px] text-muted-foreground">
                Other shops’ results show here when you{' '}
                <Link
                  href={`/app/${org.id}/settings/couriers`}
                  className="text-primary hover:underline"
                >
                  share yours
                </Link>
                .
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
