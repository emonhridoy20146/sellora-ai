'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { INTERVAL_LABEL, LEDGER_LABEL } from '@/components/billing/labels';
import { usePlatform } from '@/components/platform-context';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type {
  BillingInterval,
  LedgerType,
  ModuleCatalogue,
  PlatformPlan,
  TenantBilling,
  TenantDetail,
} from '@/lib/api/types';
import { formatDate, formatDateTime, formatMoney, humanize, parseMoney } from '@/lib/format';
import { randomKey } from '@/lib/utils';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

export default function TenantPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const { can } = usePlatform();
  const queryClient = useQueryClient();
  const tenant = useQuery({
    queryKey: ['platform', 'tenant', orgId],
    queryFn: () => api<TenantDetail>(`/platform/tenants/${orgId}`),
  });
  const billing = useQuery({
    queryKey: ['platform', 'tenant', orgId, 'billing'],
    queryFn: () => api<TenantBilling>(`/platform/billing/tenants/${orgId}`),
    enabled: can('platform.billing.view'),
  });
  const [dialog, setDialog] = useState<
    null | 'status' | 'demo' | 'adjust' | 'freeze' | 'plan' | 'trial' | 'overrides'
  >(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['platform'] });

  if (tenant.isPending) return <Skeleton className="h-96" />;
  if (tenant.isError)
    return <ErrorState error={tenant.error} onRetry={() => void tenant.refetch()} />;
  const t = tenant.data;
  const b = billing.data;
  const manageTenant = can('platform.tenants.manage');
  const manageBilling = can('platform.billing.manage');

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-3">
        <Link href="/admin/tenants">
          <ArrowLeft /> Businesses
        </Link>
      </Button>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t.name} <StatusBadge status={t.status} />
            {t.isDemo && <Badge tone="info">Demo until {formatDate(t.demoExpiresAt)}</Badge>}
          </span>
        }
        description={
          t.statusReason
            ? `Status note: ${t.statusReason}`
            : `${humanize(t.category)} · ${t.country} · ${t.currency}`
        }
        actions={
          manageTenant && (
            <>
              <Button variant="outline" size="sm" onClick={() => setDialog('demo')}>
                Demo access
              </Button>
              <Button
                variant={t.status === 'active' ? 'destructive' : 'default'}
                size="sm"
                onClick={() => setDialog('status')}
              >
                {t.status === 'active' ? 'Suspend' : 'Reactivate'}
              </Button>
            </>
          )
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Business</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <Row label="Web address name">
                <span className="font-mono">{t.slug}</span>
              </Row>
              <Row label="Legal name">{t.legalName ?? '–'}</Row>
              <Row label="Time zone">{t.timezone}</Row>
              <Row label="Phone">{t.contact.phone ?? '–'}</Row>
              <Row label="Email">{t.contact.email ?? '–'}</Row>
              <Row label="Created">{formatDateTime(t.createdAt)}</Row>
              <Row label="ID">
                <span className="font-mono text-xs">{t.id}</span>
              </Row>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Staff ({t.members.length})</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            <Table>
              <TBody>
                {t.members.map((m) => (
                  <TR key={m.id}>
                    <TD>
                      <span className="block font-medium">{m.name}</span>
                      <span className="text-xs text-muted-foreground">{m.email}</span>
                    </TD>
                    <TD>{humanize(m.roleKey)}</TD>
                    <TD className="text-right">
                      <StatusBadge status={m.status} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>

        {can('platform.billing.view') &&
          (billing.isPending ? (
            <Skeleton className="h-64 lg:col-span-2" />
          ) : billing.isError ? (
            <div className="lg:col-span-2">
              <ErrorState error={billing.error} onRetry={() => void billing.refetch()} />
            </div>
          ) : (
            b && (
              <>
                <Card>
                  <CardHeader>
                    <CardDescription>Subscription</CardDescription>
                    <CardTitle className="flex items-center gap-2">
                      {b.subscription.plan.name} <StatusBadge status={b.subscription.status} />
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className="divide-y">
                      <Row label="Billing">
                        {INTERVAL_LABEL[b.subscription.interval] ?? b.subscription.interval}
                        {b.subscription.priceMinor > 0 &&
                          ` · ${formatMoney(b.subscription.priceMinor, b.subscription.currency)}`}
                      </Row>
                      <Row label="Paid through">{humanize(b.subscription.source)}</Row>
                      <Row
                        label={b.subscription.status === 'trialing' ? 'Trial ends' : 'Period ends'}
                      >
                        {formatDate(b.subscription.trialEndsAt ?? b.subscription.currentPeriodEnd)}
                      </Row>
                      <Row label="Modules now">
                        <span className="text-[13px]">
                          {b.subscription.entitlements.modules.map(humanize).join(', ') || 'None'}
                        </span>
                      </Row>
                      {(b.subscription.overrides.addModules.length > 0 ||
                        b.subscription.overrides.removeModules.length > 0) && (
                        <Row label="Overrides">
                          <span className="text-[13px]">
                            {b.subscription.overrides.addModules.map((m) => `+${m}`).join(' ')}{' '}
                            {b.subscription.overrides.removeModules.map((m) => `−${m}`).join(' ')}
                          </span>
                        </Row>
                      )}
                    </dl>
                  </CardContent>
                  {manageBilling && (
                    <CardFooter className="flex-wrap">
                      <Button size="sm" variant="outline" onClick={() => setDialog('plan')}>
                        Give a plan
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setDialog('trial')}>
                        Extend trial
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDialog('overrides')}>
                        Overrides
                      </Button>
                    </CardFooter>
                  )}
                </Card>
                <Card>
                  <CardHeader>
                    <CardDescription>Wallet</CardDescription>
                    <CardTitle className="flex items-center gap-2">
                      {formatMoney(b.wallet.balanceMinor, b.wallet.currency)}
                      {b.wallet.status === 'frozen' && <StatusBadge status="frozen" />}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <dl className="divide-y">
                      <Row label="Free AI credit">
                        {formatMoney(b.wallet.bonusMinor, b.wallet.currency)}
                      </Row>
                      <Row label="On hold">
                        {formatMoney(b.wallet.heldMinor, b.wallet.currency)}
                      </Row>
                      <Row label="Withdrawable">
                        {formatMoney(b.wallet.withdrawableMinor, b.wallet.currency)}
                      </Row>
                      <Row label="Topped up / spent">
                        {formatMoney(b.wallet.lifetimeTopupMinor, b.wallet.currency)} /{' '}
                        {formatMoney(b.wallet.lifetimeSpentMinor, b.wallet.currency)}
                      </Row>
                    </dl>
                    {b.wallet.reconciled ? (
                      <p className="flex items-center gap-1.5 text-[13px] text-success">
                        <CircleCheck className="size-4" aria-hidden /> Ledger adds up to the balance
                      </p>
                    ) : (
                      <Alert tone="danger" title="Ledger does not match the balance">
                        Ledger sum {formatMoney(b.wallet.ledgerSumMinor, b.wallet.currency)}.
                        Investigate before changing this wallet.
                      </Alert>
                    )}
                  </CardContent>
                  {manageBilling && (
                    <CardFooter>
                      <Button size="sm" variant="outline" onClick={() => setDialog('adjust')}>
                        Credit or debit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDialog('freeze')}>
                        {b.wallet.status === 'frozen' ? 'Unfreeze' : 'Freeze'}
                      </Button>
                    </CardFooter>
                  )}
                </Card>
                <Card className="lg:col-span-2">
                  <CardHeader className="flex-row items-center justify-between">
                    <CardTitle>Recent wallet activity</CardTitle>
                    <Button asChild size="sm" variant="link">
                      <Link href={`/admin/profit?orgId=${t.id}`}>AI profit for this business</Link>
                    </Button>
                  </CardHeader>
                  <CardContent className="px-0 pb-2">
                    <Table>
                      <THead>
                        <TR>
                          <TH>When</TH>
                          <TH>What</TH>
                          <TH>By</TH>
                          <TH className="text-right">Amount</TH>
                          <TH className="text-right">Balance</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {b.ledger.map((e) => (
                          <TR key={e.id}>
                            <TD className="whitespace-nowrap text-muted-foreground">
                              {formatDateTime(e.at)}
                            </TD>
                            <TD>
                              {e.description}
                              <span className="block text-xs text-muted-foreground">
                                {LEDGER_LABEL[e.type as LedgerType] ?? e.type}
                              </span>
                            </TD>
                            <TD className="text-xs text-muted-foreground">
                              {e.actor ? `${e.actor.type}:${e.actor.id}` : '–'}
                            </TD>
                            <TD className="tabular text-right">
                              {formatMoney(e.amountMinor, b.wallet.currency, { signed: true })}
                            </TD>
                            <TD className="tabular text-right text-muted-foreground">
                              {formatMoney(e.balanceAfterMinor, b.wallet.currency)}
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </CardContent>
                </Card>
              </>
            )
          ))}
      </div>

      <ConfirmDialog
        open={dialog === 'status'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t.status === 'active' ? `Suspend ${t.name}?` : `Reactivate ${t.name}?`}
        description={
          t.status === 'active'
            ? 'Staff are blocked from the dashboard at once (billing stays reachable so they can pay). The store and AI stop.'
            : 'Staff can sign in and use the business again.'
        }
        confirmLabel={t.status === 'active' ? 'Suspend' : 'Reactivate'}
        destructive={t.status === 'active'}
        reason
        onConfirm={async (reason) => {
          await api(`/platform/tenants/${t.id}/status`, {
            method: 'PATCH',
            body: { status: t.status === 'active' ? 'suspended' : 'active', reason },
          });
          await refresh();
          toast.success('Status changed.');
        }}
      />
      {dialog === 'demo' && (
        <DemoDialog
          orgId={t.id}
          isDemo={t.isDemo}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
      {b && dialog === 'adjust' && (
        <AdjustDialog
          orgId={t.id}
          currency={b.wallet.currency}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
      {b && (
        <ConfirmDialog
          open={dialog === 'freeze'}
          onOpenChange={(o) => !o && setDialog(null)}
          title={b.wallet.status === 'frozen' ? 'Unfreeze the wallet?' : 'Freeze the wallet?'}
          description={
            b.wallet.status === 'frozen'
              ? 'AI replies and payments from the wallet start working again.'
              : 'Nothing can be spent or withdrawn until you unfreeze it. AI replies stop.'
          }
          confirmLabel={b.wallet.status === 'frozen' ? 'Unfreeze' : 'Freeze'}
          destructive={b.wallet.status !== 'frozen'}
          reason
          reasonLabel="Note"
          onConfirm={async (note) => {
            await api(`/platform/billing/tenants/${t.id}/wallet/status`, {
              method: 'PATCH',
              body: { status: b.wallet.status === 'frozen' ? 'active' : 'frozen', note },
            });
            await refresh();
          }}
        />
      )}
      {dialog === 'plan' && (
        <AssignPlanDialog orgId={t.id} onClose={() => setDialog(null)} onDone={refresh} />
      )}
      {dialog === 'trial' && (
        <ExtendTrialDialog orgId={t.id} onClose={() => setDialog(null)} onDone={refresh} />
      )}
      {b && dialog === 'overrides' && (
        <OverridesDialog
          orgId={t.id}
          current={b.subscription.overrides}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
    </>
  );
}

interface DialogProps {
  orgId: string;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}

function useAction<T>(
  fn: (v: T) => Promise<unknown>,
  onDone: () => Promise<unknown>,
  onClose: () => void,
  success: string,
) {
  return useMutation({
    mutationFn: fn,
    meta: { silent: true },
    onSuccess: async () => {
      await onDone();
      toast.success(success);
      onClose();
    },
  });
}

function DemoDialog({ orgId, isDemo, onClose, onDone }: DialogProps & { isDemo: boolean }) {
  const [hours, setHours] = useState('72');
  const save = useAction(
    (h: number | null) =>
      api(`/platform/tenants/${orgId}/demo`, { method: 'PATCH', body: { hours: h } }),
    onDone,
    onClose,
    'Demo access updated.',
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Demo access"
        description="A demo business is marked as such and expires on its own."
      >
        {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
        <Field label="Demo for how many hours?" htmlFor="demo-hours">
          <Input
            id="demo-hours"
            type="number"
            min={1}
            max={2160}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </Field>
        <DialogFooter>
          {isDemo && (
            <Button
              variant="outline"
              loading={save.isPending && save.variables === null}
              onClick={() => save.mutate(null)}
            >
              End demo
            </Button>
          )}
          <Button
            loading={save.isPending && save.variables !== null}
            disabled={!Number(hours)}
            onClick={() => save.mutate(Number(hours))}
          >
            {isDemo ? 'Extend demo' : 'Make demo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdjustDialog({ orgId, currency, onClose, onDone }: DialogProps & { currency: string }) {
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [type, setType] = useState<'topup' | 'bonus' | 'adjustment' | 'refund'>('bonus');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [key] = useState(randomKey);
  const amountMinor = parseMoney(amount, currency);
  const save = useAction(
    () =>
      api(`/platform/billing/tenants/${orgId}/wallet/adjust`, {
        body: { direction, type, amountMinor, note, idempotencyKey: key },
      }),
    onDone,
    onClose,
    'Wallet updated.',
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Credit or debit the wallet"
        description="Recorded in the ledger and the audit log with your name."
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Direction" htmlFor="adj-dir">
              <NativeSelect
                id="adj-dir"
                value={direction}
                onChange={(e) => setDirection(e.target.value as typeof direction)}
              >
                <option value="credit">Add money</option>
                <option value="debit">Take money</option>
              </NativeSelect>
            </Field>
            <Field
              label="Kind"
              htmlFor="adj-type"
              hint={
                type === 'bonus'
                  ? 'Free credit: AI only, not withdrawable.'
                  : 'Cash: spendable on anything.'
              }
            >
              <NativeSelect
                id="adj-type"
                value={type}
                onChange={(e) => setType(e.target.value as typeof type)}
              >
                <option value="bonus">Free AI credit</option>
                <option value="topup">Top-up received outside the platform</option>
                <option value="refund">Refund</option>
                <option value="adjustment">Correction</option>
              </NativeSelect>
            </Field>
          </div>
          <Field label={`Amount (${currency})`} htmlFor="adj-amount">
            <Input
              id="adj-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field
            label="Note"
            htmlFor="adj-note"
            hint="Required. Shown to the business in its wallet history."
          >
            <Textarea
              id="adj-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={save.isPending}
              disabled={!amountMinor || note.trim().length < 3}
            >
              {direction === 'credit' ? 'Add' : 'Take'}{' '}
              {amountMinor ? formatMoney(amountMinor, currency) : ''}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssignPlanDialog({ orgId, onClose, onDone }: DialogProps) {
  const plans = useQuery({
    queryKey: ['platform', 'plans'],
    queryFn: () => api<PlatformPlan[]>('/platform/billing/plans'),
  });
  const [planCode, setPlanCode] = useState('');
  const [interval, setInterval] = useState<BillingInterval>('month');
  const [periodEnd, setPeriodEnd] = useState('');
  const [note, setNote] = useState('');
  const save = useAction(
    () =>
      api(`/platform/billing/tenants/${orgId}/subscription`, {
        method: 'PUT',
        body: {
          planCode,
          interval,
          periodEnd: periodEnd ? new Date(periodEnd).toISOString() : undefined,
          note,
        },
      }),
    onDone,
    onClose,
    'Plan given.',
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Give a plan"
        description="Free of charge, for partners, support cases or deals agreed outside the platform."
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plan" htmlFor="ap-plan">
              <NativeSelect
                id="ap-plan"
                value={planCode}
                onChange={(e) => setPlanCode(e.target.value)}
                required
              >
                <option value="">Choose…</option>
                {plans.data?.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Period" htmlFor="ap-int">
              <NativeSelect
                id="ap-int"
                value={interval}
                onChange={(e) => setInterval(e.target.value as BillingInterval)}
              >
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
                <option value="lifetime">Lifetime</option>
              </NativeSelect>
            </Field>
          </div>
          <Field
            label="Ends on"
            htmlFor="ap-end"
            optional
            hint="Leave empty for one normal period."
          >
            <Input
              id="ap-end"
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
            />
          </Field>
          <Field label="Why" htmlFor="ap-note">
            <Textarea
              id="ap-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={save.isPending}
              disabled={!planCode || note.trim().length < 3}
            >
              Give plan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExtendTrialDialog({ orgId, onClose, onDone }: DialogProps) {
  const [days, setDays] = useState('7');
  const [note, setNote] = useState('');
  const save = useAction(
    () =>
      api(`/platform/billing/tenants/${orgId}/subscription/extend-trial`, {
        body: { days: Number(days), note },
      }),
    onDone,
    onClose,
    'Trial extended.',
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Extend the trial">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <Field label="Extra days" htmlFor="et-days">
            <Input
              id="et-days"
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </Field>
          <Field label="Why" htmlFor="et-note">
            <Textarea
              id="et-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={save.isPending}
              disabled={!Number(days) || note.trim().length < 3}
            >
              Extend
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OverridesDialog({
  orgId,
  current,
  onClose,
  onDone,
}: DialogProps & { current: TenantBilling['subscription']['overrides'] }) {
  const catalogue = useQuery({
    queryKey: ['platform', 'modules'],
    queryFn: () => api<ModuleCatalogue>('/platform/billing/modules'),
    staleTime: Infinity,
  });
  const [mode, setMode] = useState<Record<string, 'plan' | 'add' | 'remove'>>(() => {
    const m: Record<string, 'plan' | 'add' | 'remove'> = {};
    current.addModules.forEach((k) => (m[k] = 'add'));
    current.removeModules.forEach((k) => (m[k] = 'remove'));
    return m;
  });
  const [note, setNote] = useState('');
  const save = useAction(
    () =>
      api(`/platform/billing/tenants/${orgId}/subscription/overrides`, {
        method: 'PUT',
        body: {
          addModules: Object.keys(mode).filter((k) => mode[k] === 'add'),
          removeModules: Object.keys(mode).filter((k) => mode[k] === 'remove'),
          limits: {},
          note,
        },
      }),
    onDone,
    onClose,
    'Overrides saved.',
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        wide
        title="Module overrides"
        description="Turn single modules on or off for this business, on top of its plan."
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <div className="grid max-h-[45vh] gap-2 overflow-y-auto">
            {catalogue.data?.modules.map((m) => (
              <div
                key={m.key}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <span>
                  <span className="block font-medium">{m.name}</span>
                  <span className="text-xs text-muted-foreground">{m.description}</span>
                </span>
                <NativeSelect
                  aria-label={`${m.name} override`}
                  className="h-8 w-36"
                  value={mode[m.key] ?? 'plan'}
                  onChange={(e) =>
                    setMode((s) => ({ ...s, [m.key]: e.target.value as 'plan' | 'add' | 'remove' }))
                  }
                >
                  <option value="plan">As the plan</option>
                  <option value="add">Always on</option>
                  <option value="remove">Always off</option>
                </NativeSelect>
              </div>
            ))}
          </div>
          <Field label="Why" htmlFor="ov-note">
            <Textarea
              id="ov-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={note.trim().length < 3}>
              Save overrides
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
