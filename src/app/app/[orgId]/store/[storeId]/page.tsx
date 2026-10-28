'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, Pause, Play, Send, Trash2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { OrdersTable } from '@/components/commerce/orders-table';
import { useOrg } from '@/components/org-context';
import { storeKeys, useStore } from '@/components/stores/hooks';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Order, Store } from '@/lib/api/types';
import { formatDate, formatDateTime } from '@/lib/format';
import { STORE_STATUS, readinessSteps, storeActions, type StoreAction } from '@/lib/stores';

const ACTION: Record<
  Exclude<StoreAction, 'delete'>,
  { label: string; icon: typeof Send; done: string; confirm?: { title: string; text: string } }
> = {
  submit: { label: 'Send for review', icon: Send, done: 'Sent for review.' },
  withdraw: {
    label: 'Withdraw from review',
    icon: Undo2,
    done: 'Back to draft.',
    confirm: {
      title: 'Withdraw from review?',
      text: 'The store goes back to draft. You can send it again later; it joins the end of the queue.',
    },
  },
  pause: {
    label: 'Pause store',
    icon: Pause,
    done: 'Store paused.',
    confirm: {
      title: 'Pause the store?',
      text: 'Shoppers see a short note that the store is closed for now. Nothing is deleted, and you can reopen it at any time without another review.',
    },
  },
  resume: { label: 'Reopen store', icon: Play, done: 'Store reopened.' },
};

function RecentOrders({
  orgId,
  store,
  timezone,
}: {
  orgId: string;
  store: Store;
  timezone: string;
}) {
  const orders = useQuery({
    queryKey: ['org', orgId, 'commerce', 'orders', 'store', store.id],
    queryFn: () =>
      api<{ items: Order[] }>(`/orgs/${orgId}/orders`, { query: { storeId: store.id, limit: 5 } }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Latest orders from the store</CardTitle>
        <CardDescription>
          They arrive in Orders as pending. Call the customer, then confirm to take the stock.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {orders.data?.items.length ? (
          <OrdersTable
            orgId={orgId}
            orders={orders.data.items}
            timezone={timezone}
            showCourier={false}
          />
        ) : (
          <p className="px-5 pb-5 text-sm text-muted-foreground">
            {orders.isPending ? 'Loading…' : 'No orders yet.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function StoreOverviewPage() {
  const { org, can } = useOrg();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { storeId } = useParams<{ storeId: string }>();
  const store = useStore(org.id, storeId);
  const [busy, setBusy] = useState<StoreAction | null>(null);
  const [confirm, setConfirm] = useState<StoreAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!store.data) return null;
  const s = store.data;
  const info = STORE_STATUS[s.status];
  const steps = readinessSteps(s);
  const canPublish = can('stores.publish');
  const actions = canPublish ? storeActions(s.status) : [];

  const run = async (action: StoreAction) => {
    setBusy(action);
    setError(null);
    try {
      if (action === 'delete') {
        await api(`/orgs/${org.id}/stores/${s.id}`, { method: 'DELETE' });
        queryClient.removeQueries({ queryKey: storeKeys.store(org.id, s.id) });
        await queryClient.invalidateQueries({ queryKey: storeKeys.all(org.id) });
        toast.success('Store deleted.');
        router.push(`/app/${org.id}/store`);
        return;
      }
      const after = await api<Store>(`/orgs/${org.id}/stores/${s.id}/${action}`, {
        method: 'POST',
      });
      queryClient.setQueryData(storeKeys.store(org.id, s.id), after);
      void queryClient.invalidateQueries({ queryKey: storeKeys.all(org.id), exact: true });
      toast.success(
        action === 'submit' && after.status === 'live'
          ? 'Your store is open.'
          : ACTION[action].done,
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'store_not_ready')
        setError(err.errors.map((e) => e.message).join(' ') || err.message);
      else setError(errorMessage(err));
      void store.refetch();
      throw err;
    } finally {
      setBusy(null);
    }
  };

  const showChecklist = s.status === 'draft' || s.status === 'rejected';
  const ready = s.readiness?.ready ?? false;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="grid content-start gap-6">
        {error && <Alert tone="danger">{error}</Alert>}
        {s.status === 'rejected' && s.review.reason && (
          <Alert tone="danger" title="What needs to change">
            {s.review.reason}
          </Alert>
        )}
        {s.status === 'suspended' && (
          <Alert tone="danger" title="Store suspended">
            {s.review.reason ?? 'Contact support to reopen it.'}
          </Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>{info.label}</CardTitle>
            <CardDescription>{info.text}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {s.status === 'pending' && s.review.submittedAt && (
              <p className="text-sm text-muted-foreground">
                Sent {formatDateTime(s.review.submittedAt, org.timezone)}. You can keep editing
                while you wait.
              </p>
            )}
            {s.status === 'live' && s.liveSince && (
              <p className="text-sm text-muted-foreground">
                Open since {formatDate(s.liveSince, org.timezone)}
                {s.review.autoApproved ? ' (approved automatically)' : ''}. Changes you save show at
                once.
              </p>
            )}
            {showChecklist && (
              <ul className="grid gap-2" aria-label="Before you send it">
                {steps.map((step) => (
                  <li key={step.key} className="flex items-center gap-2 text-sm">
                    {step.done ? (
                      <CircleCheck className="size-4 text-success" aria-label="Done" />
                    ) : (
                      <CircleDashed className="size-4 text-muted-foreground" aria-label="To do" />
                    )}
                    <span className={step.done ? '' : 'font-medium'}>{step.label}</span>
                    {!step.done && step.key === 'products' && (
                      <Link
                        href={`/app/${org.id}/products/new`}
                        className="text-primary hover:underline"
                      >
                        Add product
                      </Link>
                    )}
                    {!step.done && step.key === 'contact' && (
                      <Link
                        href={`/app/${org.id}/store/${s.id}/details`}
                        className="text-primary hover:underline"
                      >
                        Add number
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {actions.some((a) => a !== 'delete') && (
              <div className="flex flex-wrap gap-2">
                {actions
                  .filter((a): a is Exclude<StoreAction, 'delete'> => a !== 'delete')
                  .map((a) => {
                    const A = ACTION[a];
                    return (
                      <Button
                        key={a}
                        variant={a === 'submit' || a === 'resume' ? 'default' : 'outline'}
                        loading={busy === a}
                        disabled={busy !== null || (a === 'submit' && !ready)}
                        onClick={() => (A.confirm ? setConfirm(a) : void run(a).catch(() => {}))}
                      >
                        <A.icon /> {A.label}
                      </Button>
                    );
                  })}
              </div>
            )}
            {!canPublish && s.status !== 'live' && (
              <p className="text-sm text-muted-foreground">
                Only the owner and admins can send the store for review or open it.
              </p>
            )}
          </CardContent>
        </Card>
        {s.status !== 'draft' && <RecentOrders orgId={org.id} store={s} timezone={org.timezone} />}
      </div>

      <div className="grid content-start gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Web address</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <span className="font-medium break-all">{s.url}</span>
            <div className="flex gap-2">
              <CopyButton value={s.url} label="Copy link" />
            </div>
            <p className="text-muted-foreground">
              {s.handleLocked
                ? 'Share it on your Facebook page and in replies.'
                : 'You can change the address in Details until the store opens.'}
            </p>
          </CardContent>
        </Card>
        {actions.includes('delete') && (
          <Card>
            <CardHeader>
              <CardTitle>Delete store</CardTitle>
              <CardDescription>
                The store and its address go away. Orders already placed stay in Orders.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                className="text-destructive"
                disabled={busy !== null}
                onClick={() => setConfirm('delete')}
              >
                <Trash2 /> Delete store
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirm === 'delete'
            ? `Delete ${s.name}?`
            : confirm
              ? (ACTION[confirm].confirm?.title ?? '')
              : ''
        }
        description={
          confirm === 'delete'
            ? 'This cannot be undone. Shoppers who open the link see that there is no store here.'
            : confirm
              ? ACTION[confirm].confirm?.text
              : undefined
        }
        confirmLabel={
          confirm === 'delete' ? 'Delete store' : confirm ? ACTION[confirm].label : 'Confirm'
        }
        destructive={confirm === 'delete'}
        onConfirm={() => (confirm ? run(confirm) : undefined)}
      />
    </div>
  );
}
