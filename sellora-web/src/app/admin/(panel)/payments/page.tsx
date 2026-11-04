'use client';

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { GATEWAY_LABEL, METHOD_LABEL } from '@/components/billing/labels';
import { usePlatform } from '@/components/platform-context';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { NativeSelect } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import type { Page, PlatformPayment } from '@/lib/api/types';
import { formatDateTime, formatMoney } from '@/lib/format';

export default function PaymentsPage() {
  const { can } = usePlatform();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [gateway, setGateway] = useState('manual');
  const [review, setReview] = useState<{ p: PlatformPayment; approve: boolean } | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['platform', 'payments', status, gateway],
    queryFn: ({ pageParam }) =>
      api<Page<PlatformPayment>>('/platform/billing/payments', {
        query: {
          status: status || undefined,
          gateway: gateway || undefined,
          limit: 50,
          before: pageParam,
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Payments"
        description="Every payment into the platform. Bank and mobile transfers wait here until someone matches them with the statement."
      />
      <Card>
        <div className="flex flex-wrap gap-2 border-b px-5 py-3">
          <label htmlFor="p-status" className="sr-only">
            Status
          </label>
          <NativeSelect
            id="p-status"
            className="w-40"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Any status</option>
            {['pending', 'succeeded', 'failed', 'canceled', 'refunded'].map((s) => (
              <option key={s} value={s}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </option>
            ))}
          </NativeSelect>
          <label htmlFor="p-gw" className="sr-only">
            Method
          </label>
          <NativeSelect
            id="p-gw"
            className="w-56"
            value={gateway}
            onChange={(e) => setGateway(e.target.value)}
          >
            <option value="">Any method</option>
            {Object.entries(GATEWAY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
        </div>
        <CardContent className="px-0 py-0">
          {q.isPending ? (
            <Skeleton className="m-5 h-40" />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={CreditCard}
              title={status === 'pending' ? 'Nothing waiting' : 'No payments match'}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Business</TH>
                  <TH>For</TH>
                  <TH>Method and reference</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Amount</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {items.map((p) => (
                  <TR key={p.id}>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(p.createdAt)}
                    </TD>
                    <TD>
                      <Link
                        href={`/admin/tenants/${p.orgId}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {p.orgId}
                      </Link>
                    </TD>
                    <TD>
                      {p.purpose === 'subscription' ? `Plan ${p.plan?.code ?? ''}` : 'Top-up'}
                    </TD>
                    <TD>
                      {p.manual ? (
                        <>
                          <span className="block">
                            {METHOD_LABEL[p.manual.method] ?? p.manual.method} from{' '}
                            {p.manual.senderAccount}
                          </span>
                          <span className="font-mono text-xs">{p.manual.transactionRef}</span>
                          {p.manual.note && (
                            <span className="block text-xs text-muted-foreground">
                              “{p.manual.note}”
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="block">{GATEWAY_LABEL[p.gateway] ?? p.gateway}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {p.gatewayRef ?? p.gatewaySessionId ?? '–'}
                          </span>
                        </>
                      )}
                      {p.reviewNote && (
                        <span className="block text-xs text-muted-foreground">
                          Note: {p.reviewNote}
                        </span>
                      )}
                    </TD>
                    <TD>
                      <StatusBadge status={p.status} />
                    </TD>
                    <TD className="tabular text-right font-medium">
                      {formatMoney(p.amountMinor, p.currency)}
                    </TD>
                    <TD className="text-right whitespace-nowrap">
                      {p.gateway === 'manual' &&
                        p.status === 'pending' &&
                        can('platform.billing.manage') && (
                          <span className="inline-flex gap-1">
                            <Button size="sm" onClick={() => setReview({ p, approve: true })}>
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setReview({ p, approve: false })}
                            >
                              Reject
                            </Button>
                          </span>
                        )}
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
      <ConfirmDialog
        open={Boolean(review)}
        onOpenChange={(o) => !o && setReview(null)}
        title={review?.approve ? 'Approve this transfer?' : 'Reject this transfer?'}
        description={
          review &&
          (review.approve
            ? `Only approve after you see ${formatMoney(review.p.amountMinor, review.p.currency)} with reference ${review.p.manual?.transactionRef} in the account statement. The money is added to the business wallet at once.`
            : 'The business sees your note. Nothing is added to the wallet.')
        }
        confirmLabel={review?.approve ? 'Approve and credit' : 'Reject'}
        destructive={review ? !review.approve : false}
        reason={review ? !review.approve : false}
        reasonLabel="Note for the business"
        onConfirm={async (note) => {
          await api(
            `/platform/billing/payments/${review!.p.id}/${review!.approve ? 'approve' : 'reject'}`,
            { body: { note } },
          );
          await queryClient.invalidateQueries({ queryKey: ['platform'] });
          toast.success(review!.approve ? 'Approved. The wallet was credited.' : 'Rejected.');
        }}
      />
    </>
  );
}
