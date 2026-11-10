'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { MoneyInput } from '@/components/commerce/money-input';
import { useOrg } from '@/components/org-context';
import { GatewayDialog, shopPaymentKeys } from '@/components/shop-payments/gateway-dialog';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  AdvanceMode,
  ShopGatewayDescriptor,
  ShopPaymentAccount,
  ShopPaymentSettings,
  ShopPaymentsOverview,
} from '@/lib/api/types';
import {
  formatDateTime,
  formatMoney,
  formatRelative,
  minorToInput,
  parseMoney,
} from '@/lib/format';
import { advanceFor, percentInput } from '@/lib/shop-payments';

function useOverview(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: shopPaymentKeys.all(orgId),
    queryFn: () => api<ShopPaymentsOverview>(`/orgs/${orgId}/shop-payments`),
    enabled,
  });
}

function AccountCard({
  account,
  descriptor,
}: {
  account: ShopPaymentAccount;
  descriptor: ShopGatewayDescriptor;
}) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ account: ShopPaymentAccount }>(`/orgs/${org.id}/shop-payments/accounts/${account.id}`, {
        method: 'PATCH',
        body: { enabled },
      }),
    onSuccess: ({ account: a }) => {
      void qc.invalidateQueries({ queryKey: shopPaymentKeys.all(org.id) });
      toast.success(
        a.enabled
          ? `${a.name} is on. Shoppers can pay with it.`
          : `${a.name} is off. Shoppers no longer see it.`,
      );
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <CreditCard className="size-4 text-muted-foreground" aria-hidden />
            {account.name}
            {account.sandbox ? (
              <Badge tone="outline">Test mode</Badge>
            ) : (
              <Badge tone="info">Live</Badge>
            )}
            {!account.enabled ? (
              <Badge tone="neutral">Off</Badge>
            ) : account.lastError ? (
              <Badge tone="danger">Last payment failed to start</Badge>
            ) : (
              <Badge tone="success">On</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {descriptor.shopperHint} · {account.credentialsHint}
          </CardDescription>
        </div>
        <Switch
          checked={account.enabled}
          disabled={toggle.isPending}
          onCheckedChange={(v) => toggle.mutate(v)}
          aria-label={`${account.name} on or off`}
        />
      </CardHeader>
      <CardContent className="grid gap-4">
        {account.lastError && (
          <Alert tone="danger" title={`${account.name} could not start a payment`}>
            {account.lastError.message} ({formatDateTime(account.lastError.at, org.timezone)}). The
            order was kept as cash on delivery. Check the keys, then save them again.
          </Alert>
        )}
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Keys</dt>
          <dd>
            {account.lastCheck.checked ? '' : 'Not checked yet. '}
            {account.lastCheck.summary}{' '}
            <span className="text-muted-foreground">· {formatRelative(account.lastCheck.at)}</span>
          </dd>
          <dt className="text-muted-foreground">Last payment</dt>
          <dd>
            {account.lastPaymentAt
              ? formatDateTime(account.lastPaymentAt, org.timezone)
              : 'None yet'}
          </dd>
        </dl>
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil /> Change keys or mode
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setRemoving(true)}>
            <Trash2 /> Remove
          </Button>
        </div>
      </CardContent>
      <GatewayDialog
        open={editing}
        onOpenChange={setEditing}
        descriptor={descriptor}
        account={account}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        destructive
        title={`Remove ${account.name}?`}
        description="Its keys are deleted. Payments on past orders stay on the orders. While a shopper’s payment is still being checked it cannot be removed; turn it off instead."
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            await api(`/orgs/${org.id}/shop-payments/accounts/${account.id}`, {
              method: 'DELETE',
            });
            await qc.invalidateQueries({ queryKey: shopPaymentKeys.all(org.id) });
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

const MODES: { value: AdvanceMode; label: string }[] = [
  { value: 'off', label: 'No advance' },
  { value: 'delivery', label: 'Delivery charge' },
  { value: 'fixed', label: 'Fixed amount' },
  { value: 'percent', label: 'Percent' },
];

function OptionsCard({ overview, anyOn }: { overview: ShopPaymentsOverview; anyOn: boolean }) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const c = org.currency;
  const s = overview.settings;
  const [cod, setCod] = useState(s.cod);
  const [fullOnline, setFullOnline] = useState(s.fullOnline);
  const [mode, setMode] = useState<AdvanceMode>(s.advance.mode);
  const [fixed, setFixed] = useState(minorToInput(s.advance.fixedMinor, c));
  const [percent, setPercent] = useState(String(s.advance.percent));
  const [zoneIds, setZoneIds] = useState<string[]>(s.advance.zoneIds);
  const [minTotal, setMinTotal] = useState(
    s.advance.minTotalMinor ? minorToInput(s.advance.minTotalMinor, c) : '',
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const fixedMinor = parseMoney(fixed || '0', c);
  const percentN = percentInput(percent || '0');
  const minTotalMinor = parseMoney(minTotal || '0', c);
  const local: Record<string, string> = {};
  if (mode === 'fixed' && (fixedMinor === null || fixedMinor <= 0))
    local.fixedMinor = 'Enter the amount';
  if (mode === 'percent' && (percentN === null || percentN <= 0))
    local.percent = 'Enter a percent from 1 to 100';
  if (minTotalMinor === null) local.minTotalMinor = 'Enter an amount';
  if (!cod && !fullOnline) local.cod = 'Keep cash on delivery on, or turn on paying in full online';

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<{ settings: ShopPaymentSettings }>(`/orgs/${org.id}/shop-payments/settings`, {
        method: 'PATCH',
        body: {
          cod,
          fullOnline,
          advance: {
            mode,
            fixedMinor: fixedMinor ?? 0,
            percent: percentN ?? 0,
            zoneIds,
            minTotalMinor: minTotalMinor ?? 0,
          },
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: shopPaymentKeys.all(org.id) });
      setErrors({});
      toast.success('Payment options saved. Your store and landing pages use them now.');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.errors.length) {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(err.fieldErrors()))
          flat[k.replace(/^advance\./, '')] = v;
        setErrors(flat);
      } else setErrors({ _: errorMessage(err) });
    },
  });

  // A worked example with the first chosen (or first) delivery area and a 1,500 order.
  const zone =
    overview.zones.find((z) => zoneIds.includes(z.id)) ??
    (zoneIds.length ? undefined : overview.zones[0]);
  const exampleGoods = 150_000;
  const example = zone
    ? {
        zone,
        total: exampleGoods + zone.chargeMinor,
        advance: advanceFor(
          {
            mode,
            fixedMinor: fixedMinor ?? 0,
            percent: percentN ?? 0,
            zoneIds,
            minTotalMinor: minTotalMinor ?? 0,
          },
          {
            totalMinor: exampleGoods + zone.chargeMinor,
            deliveryChargeMinor: zone.chargeMinor,
            zoneId: zone.id,
          },
        ),
      }
    : null;
  const shown = { ...local, ...errors };

  return (
    <Card>
      <CardHeader>
        <CardTitle>How shoppers can pay</CardTitle>
        <CardDescription>
          For your online store and landing pages. Orders you take in the inbox or add by hand are
          not affected.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setErrors({});
            if (Object.keys(local).length === 0) save.mutate();
          }}
        >
          {!anyOn && (
            <Alert tone="info">
              No gateway is on, so shoppers only see cash on delivery. These options apply once you
              connect one.
            </Alert>
          )}
          {shown._ && <Alert tone="danger">{shown._}</Alert>}
          <label className="flex items-start justify-between gap-4 text-sm">
            <span>
              <span className="font-medium">Cash on delivery</span>
              <span className="block text-muted-foreground">
                The shopper pays the courier. You can ask an advance online first (below).
              </span>
              {shown.cod && (
                <span role="alert" className="block text-[13px] text-destructive">
                  {shown.cod}
                </span>
              )}
            </span>
            <Switch checked={cod} onCheckedChange={setCod} aria-label="Cash on delivery" />
          </label>
          <label className="flex items-start justify-between gap-4 text-sm">
            <span>
              <span className="font-medium">Pay the whole order online</span>
              <span className="block text-muted-foreground">
                The shopper pays everything at checkout with a gateway you switched on.
              </span>
            </span>
            <Switch
              checked={fullOnline}
              onCheckedChange={setFullOnline}
              aria-label="Pay the whole order online"
            />
          </label>

          <fieldset className="grid gap-4 rounded-lg border p-3.5" disabled={!cod}>
            <legend className="px-1 text-sm font-medium">Advance on cash on delivery</legend>
            <p className="text-[13px] text-muted-foreground">
              Shoppers who choose cash on delivery pay this much online before the order is placed,
              which cuts orders that never get collected. The rest is paid to the courier.
            </p>
            <Segmented label="Advance" value={mode} onChange={setMode} options={MODES} />
            {mode === 'fixed' && (
              <Field label="Advance amount" htmlFor="adv-fixed" error={shown.fixedMinor}>
                <MoneyInput
                  id="adv-fixed"
                  currency={c}
                  value={fixed}
                  className="max-w-48"
                  onChange={(e) => setFixed(e.target.value)}
                />
              </Field>
            )}
            {mode === 'percent' && (
              <Field
                label="Percent of the order total"
                htmlFor="adv-percent"
                error={shown.percent}
                hint="Rounded up to whole taka."
              >
                <Input
                  id="adv-percent"
                  inputMode="decimal"
                  className="max-w-32"
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                />
              </Field>
            )}
            {mode !== 'off' && (
              <>
                {overview.zones.length > 0 && (
                  <div className="grid gap-2 text-sm">
                    <span className="font-medium">Only for these delivery areas</span>
                    <span className="text-[13px] text-muted-foreground">
                      Leave all unticked to ask it everywhere.
                    </span>
                    <div className="flex flex-wrap gap-x-5 gap-y-2">
                      {overview.zones.map((z) => (
                        <label key={z.id} className="flex items-center gap-2">
                          <Checkbox
                            checked={zoneIds.includes(z.id)}
                            onCheckedChange={(v) =>
                              setZoneIds((ids) =>
                                v === true ? [...ids, z.id] : ids.filter((x) => x !== z.id),
                              )
                            }
                          />
                          {z.name}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <Field
                  label="Only for orders of at least"
                  htmlFor="adv-min"
                  optional
                  error={shown.minTotalMinor}
                >
                  <MoneyInput
                    id="adv-min"
                    currency={c}
                    value={minTotal}
                    className="max-w-48"
                    onChange={(e) => setMinTotal(e.target.value)}
                  />
                </Field>
                {example && (
                  <p className="text-[13px] text-muted-foreground">
                    Example: a {formatMoney(exampleGoods, c)} order to {example.zone.name} (
                    {formatMoney(example.zone.chargeMinor, c)} delivery) asks{' '}
                    <span className="font-medium text-foreground">
                      {formatMoney(example.advance, c)}
                    </span>{' '}
                    online first, then {formatMoney(example.total - example.advance, c)} on
                    delivery.
                  </p>
                )}
              </>
            )}
          </fieldset>
          <div>
            <Button type="submit" loading={save.isPending}>
              Save payment options
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function PaymentsSettingsPage() {
  const { org, can } = useOrg();
  const manage = can('org.integrations.manage');
  const overview = useOverview(org.id, manage);
  const [adding, setAdding] = useState<ShopGatewayDescriptor | null>(null);

  if (!manage)
    return (
      <EmptyState icon={CreditCard} title="Only admins manage payments">
        Ask the business owner to connect your payment gateways.
      </EmptyState>
    );
  if (overview.isPending) return <Skeleton className="h-64 w-full" />;
  if (overview.isError)
    return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;

  const o = overview.data;
  const byKey = new Map(o.gateways.map((g) => [g.key, g]));
  const connected = new Set(o.accounts.map((a) => a.gateway));
  const toConnect = o.gateways.filter((g) => !connected.has(g.key));
  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Let shoppers pay at checkout with your own merchant accounts. The money goes straight to
          your account with the gateway; Sellora asks the gateway itself before it marks an order
          paid, and never shows your keys again after you save them.
        </p>
        {org.currency !== 'BDT' && (
          <Alert tone="warning">
            These gateways take taka only. Your business sells in {org.currency}, so shoppers keep
            seeing cash on delivery.
          </Alert>
        )}
        {toConnect.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {toConnect.map((g) => (
              <Button
                key={g.key}
                variant={o.accounts.length ? 'outline' : 'default'}
                onClick={() => setAdding(g)}
              >
                <Plus /> {g.name}
              </Button>
            ))}
          </div>
        )}
      </div>
      {o.accounts.length === 0 ? (
        <EmptyState icon={CreditCard} title="No gateway connected yet">
          Add bKash, Nagad, SSLCommerz, aamarPay or shurjoPay above. You need the API keys from the
          gateway’s merchant panel; start in test mode with sandbox keys.
        </EmptyState>
      ) : (
        o.accounts.map((a) => {
          const d = byKey.get(a.gateway);
          return d ? <AccountCard key={a.id} account={a} descriptor={d} /> : null;
        })
      )}
      <OptionsCard
        // Starts again from the saved options after each save.
        key={JSON.stringify(o.settings)}
        overview={o}
        anyOn={o.accounts.some((a) => a.enabled)}
      />
      {adding && (
        <GatewayDialog open onOpenChange={(v) => !v && setAdding(null)} descriptor={adding} />
      )}
    </div>
  );
}
