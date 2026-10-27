'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Landmark } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { qk } from '@/lib/api/queries';
import type { ManualMethod, Payment, PaymentMethods } from '@/lib/api/types';
import { formatMoney, minorDigits, parseMoney } from '@/lib/format';
import { cn, randomKey } from '@/lib/utils';
import { GATEWAY_LABEL, METHOD_LABEL } from './labels';

const QUICK = [500, 1_000, 2_000, 5_000];

export function TopupCard({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const methods = useQuery({
    queryKey: [...qk.billing(orgId), 'payment-methods'],
    queryFn: () => api<PaymentMethods>(`/orgs/${orgId}/billing/payment-methods`),
  });
  const [amount, setAmount] = useState('1000');
  const [choice, setChoice] = useState<string | null>(null);
  const [key, setKey] = useState(randomKey);

  const online = useMutation({
    mutationFn: (v: { gateway: string; amountMinor: number }) =>
      api<Payment>(`/orgs/${orgId}/billing/wallet/topups`, {
        body: { ...v, idempotencyKey: `${key}:${v.gateway}:${v.amountMinor}` },
      }),
    meta: { silent: true },
    onSuccess: (p) => {
      if (p.checkoutUrl) window.location.assign(p.checkoutUrl);
    },
  });

  if (methods.isPending) return <Skeleton className="h-72" />;
  if (methods.isError) return <Alert tone="danger">{errorMessage(methods.error)}</Alert>;
  const m = methods.data;
  const amountMinor = parseMoney(amount, m.currency);
  const amountError =
    amount.trim() === ''
      ? undefined
      : amountMinor === null
        ? 'Enter an amount like 1000 or 1000.50'
        : amountMinor < m.minTopupMinor
          ? `The minimum is ${formatMoney(m.minTopupMinor, m.currency)}`
          : amountMinor > m.maxTopupMinor
            ? `The maximum is ${formatMoney(m.maxTopupMinor, m.currency)}`
            : undefined;
  const valid = amountMinor !== null && !amountError;
  const options = [
    ...m.online.map((g) => ({
      key: g.key as string,
      label: GATEWAY_LABEL[g.key] ?? g.key,
      sandbox: g.sandbox,
      icon: CreditCard,
    })),
    ...(m.manual && m.manual.accounts.length > 0
      ? [{ key: 'manual', label: GATEWAY_LABEL.manual!, sandbox: false, icon: Landmark }]
      : []),
  ];
  const selected = choice ?? options[0]?.key ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add money</CardTitle>
        <CardDescription>
          Money in the wallet pays for AI replies (after free credits) and for your plan.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {options.length === 0 ? (
          <Alert tone="info" title="Payments are not switched on yet">
            The platform has not set up a payment method. Contact support to add money.
          </Alert>
        ) : (
          <>
            <Field label={`Amount (${m.currency})`} htmlFor="amount" error={amountError}>
              <Input
                id="amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setKey(randomKey());
                }}
                aria-invalid={Boolean(amountError)}
              />
            </Field>
            <div className="-mt-3 flex flex-wrap gap-2">
              {QUICK.map((q) => (
                <Button
                  key={q}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAmount(String(q))}
                >
                  {formatMoney(q * 10 ** minorDigits(m.currency), m.currency)}
                </Button>
              ))}
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-1.5 text-sm font-medium">Pay with</legend>
              {options.map((o) => (
                <label
                  key={o.key}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors',
                    selected === o.key ? 'border-primary bg-info-soft/40' : 'hover:bg-accent/40',
                  )}
                >
                  <input
                    type="radio"
                    name="method"
                    value={o.key}
                    checked={selected === o.key}
                    onChange={() => setChoice(o.key)}
                    className="accent-[var(--primary)]"
                  />
                  <o.icon className="size-4 text-muted-foreground" aria-hidden />
                  <span className="flex-1 text-sm">{o.label}</span>
                  {o.sandbox && <span className="text-xs text-muted-foreground">test mode</span>}
                </label>
              ))}
            </fieldset>
            {online.error && <Alert tone="danger">{errorMessage(online.error)}</Alert>}
            {selected === 'manual' && m.manual ? (
              <ManualTransfer
                orgId={orgId}
                currency={m.currency}
                amountMinor={valid ? amountMinor : null}
                instructions={m.manual}
                onDone={() => {
                  void queryClient.invalidateQueries({ queryKey: qk.billing(orgId) });
                }}
              />
            ) : (
              <Button
                disabled={!valid || !selected}
                loading={online.isPending}
                onClick={() =>
                  selected && amountMinor && online.mutate({ gateway: selected, amountMinor })
                }
              >
                Pay {valid ? formatMoney(amountMinor, m.currency) : ''}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ManualTransfer({
  orgId,
  currency,
  amountMinor,
  instructions,
  onDone,
}: {
  orgId: string;
  currency: string;
  amountMinor: number | null;
  instructions: NonNullable<PaymentMethods['manual']>;
  onDone: () => void;
}) {
  const [method, setMethod] = useState<ManualMethod>(instructions.accounts[0]!.method);
  const [sender, setSender] = useState('');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const account = instructions.accounts.find((a) => a.method === method);
  const submit = useMutation({
    mutationFn: () =>
      api<Payment>(`/orgs/${orgId}/billing/wallet/manual-topups`, {
        body: {
          amountMinor,
          method,
          senderAccount: sender,
          transactionRef: ref,
          note: note || undefined,
        },
      }),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(
        'Thanks. We will check the transfer and add the money, usually within a few hours.',
      );
      setSender('');
      setRef('');
      setNote('');
      onDone();
    },
  });
  const methods = [...new Set(instructions.accounts.map((a) => a.method))];

  return (
    <form
      className="grid gap-4 rounded-lg border bg-muted/40 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit.mutate();
      }}
    >
      {instructions.instructions && (
        <p className="text-sm whitespace-pre-line">{instructions.instructions}</p>
      )}
      <Field label="Send with" htmlFor="manual-method">
        <NativeSelect
          id="manual-method"
          value={method}
          onChange={(e) => setMethod(e.target.value as ManualMethod)}
        >
          {methods.map((mm) => (
            <option key={mm} value={mm}>
              {METHOD_LABEL[mm] ?? mm}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {account && (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-card p-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{account.label}</p>
            <p className="font-mono text-sm font-medium break-all">{account.account}</p>
          </div>
          <CopyButton value={account.account} />
        </div>
      )}
      <p className="text-[13px] text-muted-foreground">
        Send {amountMinor ? formatMoney(amountMinor, currency) : 'the amount'} first, then tell us
        the details below so we can match it.
      </p>
      {submit.error && <Alert tone="danger">{errorMessage(submit.error)}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your account or number" htmlFor="sender">
          <Input
            id="sender"
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            required
            minLength={3}
          />
        </Field>
        <Field label="Transaction ID" htmlFor="trx">
          <Input
            id="trx"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            required
            minLength={4}
            className="font-mono"
          />
        </Field>
      </div>
      <Field label="Note" htmlFor="note" optional>
        <Textarea
          id="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          className="min-h-14"
        />
      </Field>
      <Button
        type="submit"
        loading={submit.isPending}
        disabled={!amountMinor || sender.length < 3 || ref.length < 4}
      >
        I have sent the money
      </Button>
    </form>
  );
}
