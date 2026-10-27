'use client';

import { ChevronRight, Plus, Store } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { CreateBusinessForm } from '@/components/create-business-form';
import { SimpleFrame } from '@/components/layout/simple-frame';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useMe } from '@/lib/api/queries';

function Picker() {
  const me = useMe();
  const router = useRouter();
  const choose = useSearchParams().has('choose');
  const [creating, setCreating] = useState(false);
  const orgs = me.data?.organizations ?? [];
  const only = orgs.length === 1 ? orgs[0] : undefined;

  useEffect(() => {
    if (only && !choose) router.replace(`/app/${only.id}`);
  }, [only, choose, router]);

  if (!me.data || (only && !choose)) return null;

  if (orgs.length === 0 || creating) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {orgs.length === 0 ? `Welcome, ${me.data.user.name.split(' ')[0]}` : 'Add a business'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {orgs.length === 0
              ? 'Tell us about your shop. Your free trial starts as soon as it is created.'
              : 'Each business has its own staff, wallet, plan and data.'}
          </p>
        </div>
        {!me.data.user.emailVerified && (
          <Alert tone="warning" title="Verify your email">
            We sent a link to {me.data.user.email}. You need it to invite staff and to pay.
          </Alert>
        )}
        <Card>
          <CardContent className="pt-5">
            <CreateBusinessForm onCancel={orgs.length > 0 ? () => setCreating(false) : undefined} />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Your businesses</h1>
          <p className="text-sm text-muted-foreground">Choose where you want to work.</p>
        </div>
        <Button variant="outline" onClick={() => setCreating(true)}>
          <Plus /> Add business
        </Button>
      </div>
      <div className="grid gap-3">
        {orgs.map((o) => (
          <Link key={o.id} href={`/app/${o.id}`} className="group">
            <Card className="transition-colors group-hover:border-primary/40">
              <CardHeader className="flex-row items-center gap-3 p-4">
                <div className="rounded-lg bg-muted p-2.5">
                  <Store className="size-5 text-muted-foreground" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate">{o.name}</CardTitle>
                  <CardDescription>
                    {o.role.name} · {o.currency}
                  </CardDescription>
                </div>
                {o.status !== 'active' && <StatusBadge status={o.status} />}
                {o.isDemo && <StatusBadge status="demo" />}
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function AppHome() {
  return (
    <SimpleFrame>
      <Suspense>
        <Picker />
      </Suspense>
    </SimpleFrame>
  );
}
