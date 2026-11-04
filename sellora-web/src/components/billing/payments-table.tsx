'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { StatusBadge } from '@/components/status-badge';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { LoadMore } from '@/components/ui/load-more';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import type { Page, Payment } from '@/lib/api/types';
import { formatDateTime, formatMoney } from '@/lib/format';
import { GATEWAY_LABEL, METHOD_LABEL } from './labels';

export function PaymentsTable({ orgId, timeZone }: { orgId: string; timeZone: string }) {
  const q = useInfiniteQuery({
    queryKey: ['org', orgId, 'billing', 'payments'],
    queryFn: ({ pageParam }) =>
      api<Page<Payment>>(`/orgs/${orgId}/billing/payments`, {
        query: { limit: 10, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isPending) return <Skeleton className="m-5 h-24" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (items.length === 0) return <EmptyState icon={CreditCard} title="No payments yet" />;
  return (
    <>
      <Table>
        <THead>
          <TR>
            <TH>Date</TH>
            <TH>For</TH>
            <TH>Method</TH>
            <TH>Status</TH>
            <TH className="text-right">Amount</TH>
          </TR>
        </THead>
        <TBody>
          {items.map((p) => (
            <TR key={p.id}>
              <TD className="whitespace-nowrap text-muted-foreground">
                {formatDateTime(p.createdAt, timeZone)}
              </TD>
              <TD>
                {p.purpose === 'subscription' ? `Plan: ${p.plan?.code ?? ''}` : 'Wallet top-up'}
              </TD>
              <TD>
                <span className="block">
                  {p.manual
                    ? (METHOD_LABEL[p.manual.method] ?? p.manual.method)
                    : (GATEWAY_LABEL[p.gateway] ?? p.gateway)}
                </span>
                {p.manual && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {p.manual.transactionRef}
                  </span>
                )}
                {p.reviewNote && (
                  <span className="block text-xs text-muted-foreground">{p.reviewNote}</span>
                )}
              </TD>
              <TD>
                <StatusBadge status={p.status} />
              </TD>
              <TD className="tabular text-right font-medium">
                {formatMoney(p.amountMinor, p.currency)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <LoadMore
        hasMore={Boolean(q.hasNextPage)}
        loading={q.isFetchingNextPage}
        onClick={() => void q.fetchNextPage()}
      />
    </>
  );
}
