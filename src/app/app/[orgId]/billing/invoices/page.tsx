'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import Link from 'next/link';
import { useOrg } from '@/components/org-context';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { LoadMore } from '@/components/ui/load-more';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import type { Invoice, Page } from '@/lib/api/types';
import { formatDate, formatMoney } from '@/lib/format';

export default function InvoicesPage() {
  const { org } = useOrg();
  const q = useInfiniteQuery({
    queryKey: ['org', org.id, 'billing', 'invoices'],
    queryFn: ({ pageParam }) =>
      api<Page<Invoice>>(`/orgs/${org.id}/billing/invoices`, {
        query: { limit: 25, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardContent className="px-0 py-0">
        {q.isPending ? (
          <Skeleton className="m-5 h-40" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={ReceiptText} title="No receipts yet">
            You get a receipt for every top-up and plan payment.
          </EmptyState>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Number</TH>
                <TH>Date</TH>
                <TH>For</TH>
                <TH className="text-right">Total</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((inv) => (
                <TR key={inv.id}>
                  <TD>
                    <Link
                      href={`/app/${org.id}/billing/invoices/${inv.id}`}
                      className="font-mono font-medium text-primary hover:underline"
                    >
                      {inv.number}
                    </Link>
                  </TD>
                  <TD className="text-muted-foreground">
                    {formatDate(inv.issuedAt, org.timezone)}
                  </TD>
                  <TD>
                    {inv.lines[0]?.description ??
                      (inv.kind === 'subscription' ? 'Plan' : 'Wallet top-up')}
                  </TD>
                  <TD className="tabular text-right font-medium">
                    {formatMoney(inv.totalMinor, inv.currency)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <LoadMore
          hasMore={Boolean(q.hasNextPage)}
          loading={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        />
      </CardContent>
    </Card>
  );
}
