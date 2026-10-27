'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { METHOD_LABEL } from '@/components/billing/labels';
import { usePlatform } from '@/components/platform-context';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Page, PlatformSettings, Withdrawal } from '@/lib/api/types';
import { formatDateTime, formatMoney } from '@/lib/format';

export default function WithdrawalsPage() {
  const { can } = usePlatform();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [action, setAction] = useState<{
    w: Withdrawal;
    kind: 'approve' | 'reject' | 'paid';
  } | null>(null);
  const settings = useQuery({
    queryKey: ['platform', 'settings'],
    queryFn: () => api<PlatformSettings>('/platform/settings'),
    enabled: can('platform.settings.manage'),
  });
  const q = useInfiniteQuery({
    queryKey: ['platform', 'withdrawals', status],
    queryFn: ({ pageParam }) =>
      api<Page<Withdrawal>>('/platform/billing/withdrawals', {
        query: { status: status || undefined, limit: 50, before: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['platform'] });
  const manage = can('platform.billing.manage');

  return (
    <>
      <PageHeader
        title="Withdrawals"
        description="Businesses asking for unused wallet cash back. Money leaves the wallet only when you mark it paid."
      />
      {settings.data && !settings.data.billing.withdrawalsEnabled && (
        <Alert tone="info" title="Withdrawals are switched off" className="mb-4">
          Businesses cannot request them. Switch them on in Settings once the legal review
          (Bangladesh Bank rules on stored value) is done.
        </Alert>
      )}
      <Card>
        <div className="border-b px-5 py-3">
          <label htmlFor="w-status" className="sr-only">
            Status
          </label>
          <NativeSelect
            id="w-status"
            className="w-44"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Any status</option>
            {['requested', 'approved', 'paid', 'rejected', 'canceled'].map((s) => (
              <option key={s} value={s}>
                {s[0]!.toUpperCase() + s.slice(1)}
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
            <EmptyState icon={Banknote} title="No withdrawals" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Requested</TH>
                  <TH>Business</TH>
                  <TH>Send to</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Amount</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {items.map((w) => (
                  <TR key={w.id}>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(w.createdAt)}
                    </TD>
                    <TD>
                      {w.orgId ? (
                        <Link
                          href={`/admin/tenants/${w.orgId}`}
                          className="text-primary hover:underline"
                        >
                          {w.org?.name ?? w.orgId}
                        </Link>
                      ) : (
                        '–'
                      )}
                    </TD>
                    <TD>
                      {METHOD_LABEL[w.method]} · <span className="font-mono">{w.destination}</span>
                      {w.payoutRef && (
                        <span className="block text-xs text-muted-foreground">
                          Paid ref {w.payoutRef}
                        </span>
                      )}
                    </TD>
                    <TD>
                      <StatusBadge status={w.status} />
                    </TD>
                    <TD className="tabular text-right font-medium">
                      {formatMoney(w.amountMinor, w.currency)}
                    </TD>
                    <TD className="text-right whitespace-nowrap">
                      {manage && w.status === 'requested' && (
                        <span className="inline-flex gap-1">
                          <Button size="sm" onClick={() => setAction({ w, kind: 'approve' })}>
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setAction({ w, kind: 'reject' })}
                          >
                            Reject
                          </Button>
                        </span>
                      )}
                      {manage && w.status === 'approved' && (
                        <Button size="sm" onClick={() => setAction({ w, kind: 'paid' })}>
                          Mark paid
                        </Button>
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
        open={action?.kind === 'approve' || action?.kind === 'reject'}
        onOpenChange={(o) => !o && setAction(null)}
        title={action?.kind === 'approve' ? 'Approve this withdrawal?' : 'Reject this withdrawal?'}
        description={
          action?.kind === 'approve'
            ? 'Approving keeps the money on hold. Send it, then mark it paid with the transfer reference.'
            : 'The held money goes back to the business wallet.'
        }
        confirmLabel={action?.kind === 'approve' ? 'Approve' : 'Reject'}
        destructive={action?.kind === 'reject'}
        reason={action?.kind === 'reject'}
        reasonLabel="Note for the business"
        onConfirm={async (note) => {
          await api(`/platform/billing/withdrawals/${action!.w.id}/${action!.kind}`, {
            body: { note },
          });
          await refresh();
          toast.success('Done.');
        }}
      />
      {action?.kind === 'paid' && (
        <PaidDialog w={action.w} onClose={() => setAction(null)} onDone={refresh} />
      )}
    </>
  );
}

function PaidDialog({
  w,
  onClose,
  onDone,
}: {
  w: Withdrawal;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [payoutRef, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Mark as paid"
        description={`Confirm you sent ${formatMoney(w.amountMinor, w.currency)} to ${METHOD_LABEL[w.method]} ${w.destination}. The money then leaves the wallet for good.`}
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            api(`/platform/billing/withdrawals/${w.id}/paid`, { body: { payoutRef } })
              .then(async () => {
                await onDone();
                toast.success('Marked paid.');
                onClose();
              })
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setBusy(false));
          }}
        >
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Transfer reference" htmlFor="payout-ref">
            <Input
              id="payout-ref"
              className="font-mono"
              value={payoutRef}
              onChange={(e) => setRef(e.target.value)}
              required
              minLength={3}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={payoutRef.trim().length < 3}>
              Mark paid
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
