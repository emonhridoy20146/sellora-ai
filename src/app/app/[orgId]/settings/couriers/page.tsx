'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RefreshCw, Star, Trash2, Truck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { AccountDialog } from '@/components/couriers/account-dialog';
import {
  courierKeys,
  fraudKeys,
  useCourierAccounts,
  useCourierProviders,
  useFraudSettings,
} from '@/components/couriers/data';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type {
  CourierAccount,
  CourierAccountResult,
  CourierDescriptor,
  CourierStore,
  FraudSettings,
} from '@/lib/api/types';
import { formatWeight } from '@/lib/couriers';
import { formatDateTime, formatRelative } from '@/lib/format';

function useAccountPatch(account: CourierAccount) {
  const { org } = useOrg();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<CourierAccountResult>(`/orgs/${org.id}/couriers/accounts/${account.id}`, {
        method: 'PATCH',
        body,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: courierKeys.all(org.id) }),
  });
}

/** The pickup store: loads the courier's stores (a live check) only when asked. */
function PickupStore({
  account,
  descriptor,
}: {
  account: CourierAccount;
  descriptor: CourierDescriptor;
}) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const [stores, setStores] = useState<CourierStore[] | null>(null);
  const patch = useAccountPatch(account);
  const load = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<CourierAccountResult>(`/orgs/${org.id}/couriers/accounts/${account.id}/check`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: courierKeys.all(org.id) });
      if (!r.check?.ok) toast.error(r.check?.summary ?? 'The courier did not answer.');
      else if (!r.check.stores.length)
        toast.error(`No pickup stores yet. Add one in your ${descriptor.name} panel first.`);
      else setStores(r.check.stores);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const current = account.settings.storeId;
  const missing = descriptor.pickupStore === 'required' && !current;

  if (stores)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`store-${account.id}`} className="sr-only">
          Pickup store
        </label>
        <NativeSelect
          id={`store-${account.id}`}
          className="h-8 w-auto max-w-72"
          value={current ?? ''}
          disabled={patch.isPending}
          onChange={(e) =>
            patch.mutate(
              { settings: { storeId: e.target.value || null } },
              {
                onSuccess: () => {
                  setStores(null);
                  toast.success('Pickup store saved.');
                },
              },
            )
          }
        >
          {(descriptor.pickupStore === 'optional' || !current) && (
            <option value="">
              {descriptor.pickupStore === 'optional'
                ? `${descriptor.name}’s default store`
                : 'Choose a store'}
            </option>
          )}
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.address ? ` · ${s.address}` : ''}
            </option>
          ))}
        </NativeSelect>
        <Button variant="ghost" size="sm" onClick={() => setStores(null)}>
          Close
        </Button>
      </div>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {missing ? (
        <Badge tone="warning">Not chosen: parcels cannot be booked</Badge>
      ) : (
        <span>
          {current
            ? (account.settings.storeName ?? `Store ${current}`)
            : `${descriptor.name}’s default store`}
        </span>
      )}
      <Button variant="ghost" size="sm" loading={load.isPending} onClick={() => load.mutate()}>
        {missing ? 'Choose' : 'Change'}
      </Button>
    </span>
  );
}

function SecretValue({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs break-all">
        {shown ? value : '•'.repeat(24)}
      </code>
      <Button variant="ghost" size="sm" onClick={() => setShown((v) => !v)}>
        {shown ? 'Hide' : 'Show'}
      </Button>
      <CopyButton value={value} label="Copy secret" />
    </span>
  );
}

function AccountCard({
  account,
  descriptor,
}: {
  account: CourierAccount;
  descriptor: CourierDescriptor;
}) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const patch = useAccountPatch(account);
  const check = useMutation({
    mutationFn: () =>
      api<CourierAccountResult>(`/orgs/${org.id}/couriers/accounts/${account.id}/check`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: courierKeys.all(org.id) });
      if (r.check?.ok) toast.success(r.check.summary);
      else toast.error(r.check?.summary ?? 'The check failed.');
    },
  });
  const deliveryType = descriptor.deliveryTypes.find(
    (t) => t.value === account.settings.deliveryType,
  );
  const w = account.webhook;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Truck className="size-4 text-muted-foreground" aria-hidden />
            {account.name}
            {account.isDefault && (
              <Badge tone="info">
                <Star aria-hidden /> Default
              </Badge>
            )}
            {account.sandbox && <Badge tone="outline">Test mode</Badge>}
            {!account.enabled ? (
              <Badge tone="neutral">Off</Badge>
            ) : account.status === 'error' ? (
              <Badge tone="danger">Not working</Badge>
            ) : (
              <Badge tone="success">Working</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {account.providerName} · {account.credentialsHint}
          </CardDescription>
        </div>
        <Switch
          checked={account.enabled}
          disabled={patch.isPending}
          onCheckedChange={(v) =>
            patch.mutate(
              { enabled: v },
              { onSuccess: () => toast.success(`${account.name} turned ${v ? 'on' : 'off'}.`) },
            )
          }
          aria-label={`${account.name} on or off`}
        />
      </CardHeader>
      <CardContent className="grid gap-4">
        {account.status === 'error' && (
          <Alert tone="danger" title={`${descriptor.name} stopped accepting this account`}>
            {account.statusReason ?? 'Check the keys in the courier panel, then save them again.'}
          </Alert>
        )}
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          {descriptor.pickupStore !== 'none' && (
            <>
              <dt className="text-muted-foreground">Pickup store</dt>
              <dd>
                <PickupStore account={account} descriptor={descriptor} />
              </dd>
            </>
          )}
          {deliveryType && (
            <>
              <dt className="text-muted-foreground">Delivery type</dt>
              <dd>{deliveryType.label}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Usual weight</dt>
          <dd>{formatWeight(account.defaultWeightGrams)}</dd>
          <dt className="text-muted-foreground">Last check</dt>
          <dd>
            {account.lastCheck ? (
              <>
                {account.lastCheck.ok ? '' : 'Failed: '}
                {account.lastCheck.summary}{' '}
                <span className="text-muted-foreground">
                  · {formatRelative(account.lastCheck.at)}
                </span>
              </>
            ) : (
              'Never'
            )}
          </dd>
        </dl>

        <div className="grid gap-2 rounded-lg border p-3.5">
          <p className="text-sm font-medium">Status updates from {descriptor.name}</p>
          <p className="text-[13px] text-muted-foreground">
            {w.help} Sellora also checks each parcel with {descriptor.name} every hour, so tracking
            works without this, only slower.
          </p>
          <div className="grid gap-2 text-sm">
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Callback URL</span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs break-all">{w.url}</code>
              <CopyButton value={w.url} label="Copy URL" />
            </span>
            {w.secret && (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">
                  {w.auth === 'bearer' ? 'Auth token' : 'Secret'}
                </span>
                <SecretValue value={w.secret} />
              </span>
            )}
            <span className="text-[13px] text-muted-foreground">
              {w.lastReceivedAt
                ? `Last update received ${formatDateTime(w.lastReceivedAt, org.timezone)}.`
                : 'No update received yet.'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button
            variant="outline"
            size="sm"
            loading={check.isPending}
            onClick={() => check.mutate()}
          >
            <RefreshCw /> Check connection
          </Button>
          {!account.isDefault && account.enabled && (
            <Button
              variant="outline"
              size="sm"
              disabled={patch.isPending}
              onClick={() =>
                patch.mutate(
                  { isDefault: true },
                  { onSuccess: () => toast.success(`${account.name} is now the default.`) },
                )
              }
            >
              <Star /> Make default
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </Button>
          {w.secret && (
            <Button variant="ghost" size="sm" onClick={() => setRotating(true)}>
              New secret
            </Button>
          )}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setRemoving(true)}>
            <Trash2 /> Remove
          </Button>
        </div>
      </CardContent>
      <AccountDialog
        open={editing}
        onOpenChange={setEditing}
        descriptor={descriptor}
        account={account}
      />
      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        title="Make a new webhook secret?"
        description={`Updates from ${descriptor.name} are refused until you paste the new secret into the ${descriptor.name} panel.`}
        confirmLabel="Make new secret"
        onConfirm={async () => {
          await api<CourierAccount>(
            `/orgs/${org.id}/couriers/accounts/${account.id}/webhook-secret`,
            { method: 'POST' },
          );
          await qc.invalidateQueries({ queryKey: courierKeys.all(org.id) });
          toast.success('New secret made. Paste it into the courier panel.');
        }}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        destructive
        title={`Remove ${account.name}?`}
        description="Its parcel history stays on the orders. Accounts with parcels still on the way cannot be removed; turn them off instead."
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            await api(`/orgs/${org.id}/couriers/accounts/${account.id}`, { method: 'DELETE' });
            await qc.invalidateQueries({ queryKey: courierKeys.all(org.id) });
            toast.success(`${account.name} removed.`);
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </Card>
  );
}

function SharingCard() {
  const { org, can } = useOrg();
  const qc = useQueryClient();
  const settings = useFraudSettings(org.id);
  const save = useMutation({
    mutationFn: (shareOutcomes: boolean) =>
      api<FraudSettings>(`/orgs/${org.id}/fraud-check/settings`, {
        method: 'PATCH',
        body: { shareOutcomes },
      }),
    onSuccess: (next) => {
      qc.setQueryData(fraudKeys.settings(org.id), next);
      void qc.invalidateQueries({ queryKey: fraudKeys.all(org.id) });
      toast.success(
        next.shareOutcomes
          ? 'Sharing on. You now see other shops’ results too.'
          : 'Sharing off. What you shared has been deleted.',
      );
    },
  });
  if (settings.isPending) return <Skeleton className="h-28" />;
  if (settings.isError) return null;
  const s = settings.data;
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle>Delivery risk from other shops</CardTitle>
          <CardDescription>
            Delivery risk on orders always uses your own history.{' '}
            {s.networkAvailable
              ? 'Shops that share their courier results also see how a number did at the other sharing shops.'
              : 'Sellora has not switched on sharing between shops.'}
          </CardDescription>
        </div>
        {s.networkAvailable && (
          <Switch
            checked={s.shareOutcomes}
            disabled={save.isPending || !can('org.settings.manage')}
            onCheckedChange={(v) => save.mutate(v)}
            aria-label="Share delivery results with other shops"
          />
        )}
      </CardHeader>
      {s.networkAvailable && (
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <p>
            What is shared: a coded form of the customer’s phone number and whether the courier
            delivered or returned the parcel. Names, addresses, products and prices are never
            shared, and nobody sees which shop a result came from.
          </p>
          <p>
            {s.shareOutcomes
              ? `Sharing since ${formatDateTime(s.sharedSince, org.timezone)}. Turning it off deletes what you shared.`
              : 'Off. Turn it on to share your results and see other shops’ results.'}
          </p>
          {!can('org.settings.manage') && (
            <p>Only the business owner or an admin can change this.</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function CouriersSettingsPage() {
  const { org, can, modules } = useOrg();
  const manage = can('org.integrations.manage');
  const inPlan = modules === null || modules.includes('couriers');
  const providers = useCourierProviders(org.id, manage && inPlan);
  const accounts = useCourierAccounts(org.id, manage && inPlan);
  const [adding, setAdding] = useState<CourierDescriptor | null>(null);

  if (!manage)
    return (
      <EmptyState icon={Truck} title="Only admins manage couriers">
        Ask the business owner to connect your courier accounts.
      </EmptyState>
    );
  if (!inPlan)
    return (
      <EmptyState
        icon={Truck}
        title="Courier booking is not in your plan"
        action={
          can('billing.view') && (
            <Button asChild>
              <Link href={`/app/${org.id}/billing/plans`}>See plans</Link>
            </Button>
          )
        }
      >
        Upgrade to book Steadfast, Pathao and RedX parcels from your orders and track them here.
      </EmptyState>
    );

  const byKey = new Map(providers.data?.map((d) => [d.key, d]));
  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Connect your courier merchant accounts. Sellora books parcels from confirmed orders,
          follows each one until it is delivered or comes back, and moves the order along.
        </p>
        <div className="flex flex-wrap gap-2">
          {providers.data?.map((d) => (
            <Button
              key={d.key}
              variant={accounts.data?.length ? 'outline' : 'default'}
              onClick={() => setAdding(d)}
            >
              <Plus /> {d.name}
            </Button>
          ))}
        </div>
      </div>
      {accounts.isPending || providers.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : accounts.isError || providers.isError ? (
        <ErrorState
          error={accounts.error ?? providers.error}
          onRetry={() => {
            void accounts.refetch();
            void providers.refetch();
          }}
        />
      ) : accounts.data.length === 0 ? (
        <EmptyState icon={Truck} title="No courier connected yet">
          Add your Steadfast, Pathao or RedX account above. You need the API keys from the courier’s
          merchant panel.
        </EmptyState>
      ) : (
        accounts.data.map((a) => {
          const d = byKey.get(a.provider);
          return d ? <AccountCard key={a.id} account={a} descriptor={d} /> : null;
        })
      )}
      {(modules === null || modules.includes('fraud')) && <SharingCard />}
      {adding && (
        <AccountDialog
          open
          onOpenChange={(v) => !v && setAdding(null)}
          descriptor={adding}
          firstAccount={accounts.data?.length === 0}
        />
      )}
    </div>
  );
}
