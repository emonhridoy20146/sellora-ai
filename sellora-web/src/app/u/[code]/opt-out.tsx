'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { BellOff, CheckCircle2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';

interface Link {
  shop: string;
  phone: string;
  stopped: boolean;
}

const VALID = /^[A-Za-z0-9]{6,16}$/;

/** Bilingual: shoppers in Bangladesh read either, and the page does not know which. */
export function OptOut({ code }: { code: string }) {
  const valid = VALID.test(code);
  const link = useQuery({
    queryKey: ['public', 'sms-opt-out', code],
    queryFn: () => api<Link>(`/public/sms/opt-out/${code}`, { noRefresh: true }),
    enabled: valid,
  });
  const stop = useMutation({
    mutationFn: () =>
      api<{ stopped: true }>(`/public/sms/opt-out/${code}`, { method: 'POST', noRefresh: true }),
    meta: { silent: true },
  });

  if (!valid || (link.isError && link.error instanceof ApiError && link.error.status === 404))
    return (
      <Card>
        <h1 className="text-lg font-semibold">This link is not valid</h1>
        <p className="text-sm text-muted-foreground" lang="bn">
          লিংকটি সঠিক নয়।
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Check that you opened the whole link from the SMS.
        </p>
      </Card>
    );
  if (link.isPending)
    return (
      <Card>
        <Spinner />
      </Card>
    );
  if (link.isError)
    return (
      <Card>
        <Alert tone="danger">{errorMessage(link.error)}</Alert>
        <Button variant="outline" className="mt-4" onClick={() => void link.refetch()}>
          Try again
        </Button>
      </Card>
    );

  const { shop, phone } = link.data;
  if (link.data.stopped || stop.isSuccess)
    return (
      <Card>
        <CheckCircle2 className="size-8 text-success" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold">Done</h1>
        <p role="status" className="mt-1 text-sm">
          {shop} will not send offers to {phone} by SMS any more. Order updates still come.
        </p>
        <p className="mt-2 text-sm text-muted-foreground" lang="bn">
          হয়ে গেছে। {shop} আর {phone} নম্বরে SMS-এ অফার পাঠাবে না। অর্ডারের আপডেট আসবে।
        </p>
      </Card>
    );

  return (
    <Card>
      <BellOff className="size-8 text-muted-foreground" aria-hidden />
      <h1 className="mt-3 text-lg font-semibold">Stop SMS offers from {shop}?</h1>
      <p className="text-sm text-muted-foreground" lang="bn">
        {shop} থেকে অফারের SMS বন্ধ করবেন?
      </p>
      <p className="mt-4 text-sm">
        {phone} gets offers and reminders from {shop}. Messages about your orders (confirmation,
        delivery) still come.
      </p>
      <p className="mt-2 text-sm text-muted-foreground" lang="bn">
        {phone} নম্বরে {shop} থেকে অফার ও রিমাইন্ডার আসে। অর্ডারের মেসেজ (কনফার্ম, ডেলিভারি) আসতেই
        থাকবে।
      </p>
      {stop.isError && (
        <Alert tone="danger" className="mt-4">
          {errorMessage(stop.error)}
        </Alert>
      )}
      <Button className="mt-5 w-full" loading={stop.isPending} onClick={() => stop.mutate()}>
        Stop offers · <span lang="bn">অফার বন্ধ করুন</span>
      </Button>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border bg-card p-6 shadow-xs">{children}</div>;
}
