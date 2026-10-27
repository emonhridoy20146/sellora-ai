'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { NativeSelect } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import type { LedgerEntry, LedgerType, Page } from '@/lib/api/types';
import { formatCredits, formatDateTime, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { LEDGER_LABEL } from './labels';

export function LedgerTable({
  orgId,
  currency,
  timeZone,
  limit = 25,
  filter = true,
  paginate = true,
}: {
  orgId: string;
  currency: string;
  timeZone: string;
  limit?: number;
  filter?: boolean;
  paginate?: boolean;
}) {
  const [type, setType] = useState<LedgerType | ''>('');
  const q = useInfiniteQuery({
    queryKey: ['org', orgId, 'billing', 'ledger', type, limit],
    queryFn: ({ pageParam }) =>
      api<Page<LedgerEntry>>(`/orgs/${orgId}/billing/wallet/ledger`, {
        query: { limit, cursor: pageParam, type: type || undefined },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      {filter && (
        <div className="flex justify-end border-b px-5 py-3">
          <label className="sr-only" htmlFor="ledger-type">
            Filter by type
          </label>
          <NativeSelect
            id="ledger-type"
            className="h-8 w-44"
            value={type}
            onChange={(e) => setType(e.target.value as LedgerType | '')}
          >
            <option value="">All activity</option>
            {Object.entries(LEDGER_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {q.isPending ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={ReceiptText} title="No wallet activity yet" />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>When</TH>
              <TH>What</TH>
              <TH className="text-right">Amount</TH>
              <TH className="text-right">Balance</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((e) => (
              <TR key={e.id}>
                <TD className="whitespace-nowrap text-muted-foreground">
                  {formatDateTime(e.at, timeZone)}
                </TD>
                <TD>
                  <span className="block">{e.description}</span>
                  <span className="text-xs text-muted-foreground">
                    {LEDGER_LABEL[e.type as LedgerType] ?? e.type}
                    {e.credits !== null && e.type !== 'ai_usage'
                      ? ` · ${formatCredits(e.credits)}`
                      : ''}
                  </span>
                </TD>
                <TD
                  className={cn(
                    'tabular text-right font-medium whitespace-nowrap',
                    e.amountMinor > 0 ? 'text-success' : '',
                  )}
                >
                  {formatMoney(e.amountMinor, currency, { signed: true })}
                </TD>
                <TD className="tabular text-right whitespace-nowrap text-muted-foreground">
                  {formatMoney(e.balanceAfterMinor, currency)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <LoadMore
        hasMore={paginate && Boolean(q.hasNextPage)}
        loading={q.isFetchingNextPage}
        onClick={() => void q.fetchNextPage()}
      />
    </div>
  );
}
