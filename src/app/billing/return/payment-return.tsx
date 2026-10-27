'use client';

import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Clock } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Payment } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const POLL_FOR_MS = 60_000;

/**
 * Where payment gateways send the browser back. The browser's word is never trusted: we
 * ask our API, which only marks a payment paid after the gateway itself confirmed it.
 */
export function PaymentReturn({
  orgId,
  paymentId,
  hint,
}: {
  orgId: string;
  paymentId: string;
  hint: string;
}) {
  const valid = OBJECT_ID.test(orgId) && OBJECT_ID.test(paymentId);
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  const q = useQuery({
    queryKey: ['payment-return', orgId, paymentId],
    queryFn: () => api<Payment>(`/orgs/${orgId}/billing/payments/${paymentId}`),
    enabled: valid,
    refetchInterval: (query) =>
      query.state.data?.status === 'pending' && Date.now() - started < POLL_FOR_MS ? 2_500 : false,
  });
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2_500);
    return () => clearInterval(t);
  }, []);
  const p = q.data;
  const back =
    p?.purpose === 'subscription' ? `/app/${orgId}/billing` : `/app/${orgId}/billing/wallet`;
  const gaveUp = now - started >= POLL_FOR_MS;

  let body: React.ReactNode;
  if (!valid) body = <p className="text-sm text-muted-foreground">This link is incomplete.</p>;
  else if (q.isPending) body = <Spinner />;
  else if (q.isError) body = <p className="text-sm text-destructive">{errorMessage(q.error)}</p>;
  else if (p!.status === 'succeeded')
    body = (
      <Result icon={<CircleCheck className="size-8 text-success" />} title="Payment received">
        {formatMoney(p!.amountMinor, p!.currency)}{' '}
        {p!.purpose === 'subscription' ? 'paid for your plan.' : 'added to your wallet.'}
      </Result>
    );
  else if (p!.status === 'pending')
    body = (
      <Result
        icon={gaveUp ? <Clock className="size-8 text-warning" /> : <Spinner className="p-0" />}
        title={gaveUp ? 'Still waiting for the payment company' : 'Confirming your payment…'}
      >
        {gaveUp
          ? 'This can take a few minutes. You can close this page; the money is added as soon as it is confirmed.'
          : hint === 'cancel'
            ? 'Checking with the payment company.'
            : 'Please keep this page open for a moment.'}
      </Result>
    );
  else
    body = (
      <Result
        icon={<CircleX className="size-8 text-destructive" />}
        title="The payment did not go through"
      >
        {p!.failureReason ?? 'No money was taken. You can try again.'}
      </Result>
    );

  return (
    <div className="flex min-h-dvh flex-col items-center px-4 pt-10">
      <Brand />
      <div className="mt-10 w-full max-w-sm">
        <AuthCard title="Payment">
          <div className="grid gap-5">
            {body}
            {valid && (
              <Button asChild>
                <Link href={back}>Back to billing</Link>
              </Button>
            )}
          </div>
        </AuthCard>
      </div>
    </div>
  );
}

function Result({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 text-center" role="status">
      {icon}
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
