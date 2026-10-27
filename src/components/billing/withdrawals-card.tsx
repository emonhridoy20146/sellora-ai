'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { qk } from '@/lib/api/queries';
import type { Page, WalletBalance, Withdrawal } from '@/lib/api/types';
import { formatDate, formatMoney, parseMoney } from '@/lib/format';
import { METHOD_LABEL } from './labels';

/** Taking unused cash back out. Only shown when the platform has switched withdrawals on. */
export function WithdrawalsCard({
  orgId,
  wallet,
  canManage,
}: {
  orgId: string;
  wallet: WalletBalance;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: [...qk.billing(orgId), 'withdrawals'],
    queryFn: () =>
      api<Page<Withdrawal>>(`/orgs/${orgId}/billing/withdrawals`, { query: { limit: 20 } }),
  });
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'bkash' | 'nagad' | 'bank' | 'original_method'>('bkash');
  const [destination, setDestination] = useState('');
  const amountMinor = parseMoney(amount, wallet.currency);
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.billing(orgId) });
  const request = useMutation({
    mutationFn: () =>
      api(`/orgs/${orgId}/billing/withdrawals`, { body: { amountMinor, method, destination } }),
    meta: { silent: true },
    onSuccess: async () => {
      setAmount('');
      setDestination('');
      await refresh();
      toast.success('Request sent. The money is held until the platform pays it out.');
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api(`/orgs/${orgId}/billing/withdrawals/${id}/cancel`, { method: 'POST' }),
    onSuccess: refresh,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Withdraw money</CardTitle>
        <CardDescription>
          You can take out up to {formatMoney(wallet.withdrawableMinor, wallet.currency)}. Free AI
          credit cannot be withdrawn. The platform reviews each request.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {canManage && wallet.withdrawableMinor > 0 && (
          <form
            className="grid gap-4 sm:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              request.mutate();
            }}
          >
            {request.error && (
              <Alert tone="danger" className="sm:col-span-3">
                {errorMessage(request.error)}
              </Alert>
            )}
            <Field label={`Amount (${wallet.currency})`} htmlFor="w-amount">
              <Input
                id="w-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Send to" htmlFor="w-method">
              <NativeSelect
                id="w-method"
                value={method}
                onChange={(e) => setMethod(e.target.value as typeof method)}
              >
                {(['bkash', 'nagad', 'bank', 'original_method'] as const).map((k) => (
                  <option key={k} value={k}>
                    {METHOD_LABEL[k]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Account details" htmlFor="w-dest">
              <Input
                id="w-dest"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="Number or bank account"
              />
            </Field>
            <div className="sm:col-span-3">
              <Button
                type="submit"
                variant="outline"
                loading={request.isPending}
                disabled={
                  !amountMinor ||
                  amountMinor > wallet.withdrawableMinor ||
                  destination.trim().length < 3
                }
              >
                Request withdrawal
              </Button>
            </div>
          </form>
        )}
        {list.data && list.data.items.length > 0 && (
          <div className="-mx-5">
            <Table>
              <THead>
                <TR>
                  <TH>Requested</TH>
                  <TH>To</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Amount</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {list.data.items.map((w) => (
                  <TR key={w.id}>
                    <TD className="text-muted-foreground">{formatDate(w.createdAt)}</TD>
                    <TD>
                      {METHOD_LABEL[w.method]} · {w.destination}
                      {w.payoutRef && (
                        <span className="block text-xs text-muted-foreground">
                          Ref {w.payoutRef}
                        </span>
                      )}
                      {w.reviewNote && (
                        <span className="block text-xs text-muted-foreground">{w.reviewNote}</span>
                      )}
                    </TD>
                    <TD>
                      <StatusBadge status={w.status} />
                    </TD>
                    <TD className="tabular text-right">{formatMoney(w.amountMinor, w.currency)}</TD>
                    <TD className="text-right">
                      {canManage && w.status === 'requested' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={cancel.isPending && cancel.variables === w.id}
                          onClick={() => cancel.mutate(w.id)}
                        >
                          Cancel
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
