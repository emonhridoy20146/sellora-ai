'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { usePlatform } from '@/components/platform-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { PlatformCreditRate, PlatformPlan, PlatformSettings } from '@/lib/api/types';
import { formatDateTime, minorToInput, parseMoney } from '@/lib/format';

export default function PlatformSettingsPage() {
  const settings = useQuery({
    queryKey: ['platform', 'settings'],
    queryFn: () => api<PlatformSettings>('/platform/settings'),
  });
  const plans = useQuery({
    queryKey: ['platform', 'plans'],
    queryFn: () => api<PlatformPlan[]>('/platform/billing/plans'),
  });
  const rates = useQuery({
    queryKey: ['platform', 'credit-rates'],
    queryFn: () => api<PlatformCreditRate[]>('/platform/billing/credit-rates'),
  });
  const currency = rates.data?.[0]?.currency ?? plans.data?.flatMap((p) => p.prices)[0]?.currency;

  return (
    <>
      <PageHeader
        title="Platform settings"
        description="Sign-up, trials, billing rules and support contacts. Every change is recorded in the audit log."
      />
      {settings.isError ? (
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : settings.isPending || rates.isPending || plans.isPending ? (
        <Skeleton className="h-96" />
      ) : !currency ? (
        <Alert tone="warning">
          No currency is set up yet. Create a plan or publish an AI credit price first, so money
          amounts here have a currency.
        </Alert>
      ) : (
        <SettingsForm
          key={settings.data.updatedAt ?? 'init'}
          initial={settings.data}
          plans={plans.data ?? []}
          currency={currency}
        />
      )}
    </>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm">
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        {hint && <span className="block text-muted-foreground">{hint}</span>}
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function SettingsForm({
  initial,
  plans,
  currency,
}: {
  initial: PlatformSettings;
  plans: PlatformPlan[];
  currency: string;
}) {
  const { can } = usePlatform();
  const editable = can('platform.settings.manage');
  const queryClient = useQueryClient();
  const [s, setS] = useState(initial);
  const [taxPct, setTaxPct] = useState(String(initial.billing.taxRateBps / 100));
  const [minTopup, setMinTopup] = useState(minorToInput(initial.billing.minTopupMinor, currency));
  const [maxTopup, setMaxTopup] = useState(minorToInput(initial.billing.maxTopupMinor, currency));
  const set = <K extends keyof PlatformSettings>(
    k: K,
    v: Partial<PlatformSettings[K]> | PlatformSettings[K],
  ) =>
    setS((cur) => ({
      ...cur,
      [k]: typeof v === 'object' && v !== null ? { ...(cur[k] as object), ...v } : v,
    }));

  const taxBps = /^\d+(\.\d{1,2})?$/.test(taxPct.trim()) ? Math.round(Number(taxPct) * 100) : null;
  const minMinor = parseMoney(minTopup, currency);
  const maxMinor = parseMoney(maxTopup, currency);
  const valid =
    taxBps !== null &&
    taxBps <= 5000 &&
    minMinor !== null &&
    maxMinor !== null &&
    minMinor > 0 &&
    maxMinor >= minMinor;

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<PlatformSettings>('/platform/settings', {
        method: 'PATCH',
        body: {
          signupEnabled: s.signupEnabled,
          trial: s.trial,
          demo: s.demo,
          maintenance: s.maintenance,
          support: {
            ...(s.support.email.trim() ? { email: s.support.email.trim() } : {}),
            whatsapp: s.support.whatsapp.trim(),
          },
          billing: {
            withdrawalsEnabled: s.billing.withdrawalsEnabled,
            graceDays: s.billing.graceDays,
            taxRateBps: taxBps,
            taxLabel: s.billing.taxLabel.trim(),
            minTopupMinor: minMinor,
            maxTopupMinor: maxMinor,
          },
        },
      }),
    onSuccess: async (next) => {
      queryClient.setQueryData(['platform', 'settings'], next);
      await queryClient.invalidateQueries({ queryKey: ['platform', 'billing'] });
      toast.success('Settings saved.');
    },
  });
  const errs: Record<string, string> =
    save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const trialPlans = plans.filter((p) => p.isActive && p.trialEligible);
  const ro = !editable;

  return (
    <form
      className="grid gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      {ro && (
        <Alert tone="info">
          You can view these settings. Changing them needs the settings permission.
        </Alert>
      )}
      {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>Sign-up and trials</CardTitle>
          <CardDescription>What a new business gets when it signs up.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Toggle
            id="st-signup"
            label="Open sign-up"
            hint="Off: only invited people can create accounts."
            checked={s.signupEnabled}
            onChange={(v) => set('signupEnabled', v)}
            disabled={ro}
          />
          <Toggle
            id="st-trial"
            label="Free trial for new businesses"
            checked={s.trial.enabled}
            onChange={(v) => set('trial', { enabled: v })}
            disabled={ro}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Trial length (days)" htmlFor="st-trial-days" error={errs['trial.days']}>
              <Input
                id="st-trial-days"
                type="number"
                min={0}
                max={90}
                value={s.trial.days}
                disabled={ro || !s.trial.enabled}
                onChange={(e) => set('trial', { days: Number(e.target.value) })}
              />
            </Field>
            <Field label="Trial plan" htmlFor="st-trial-plan" error={errs['trial.planCode']}>
              <NativeSelect
                id="st-trial-plan"
                value={s.trial.planCode}
                disabled={ro || !s.trial.enabled}
                onChange={(e) => set('trial', { planCode: e.target.value })}
              >
                {!trialPlans.some((p) => p.code === s.trial.planCode) && (
                  <option value={s.trial.planCode}>{s.trial.planCode} (not trial-eligible)</option>
                )}
                {trialPlans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              label="Demo access default (hours)"
              htmlFor="st-demo"
              error={errs['demo.defaultHours']}
            >
              <Input
                id="st-demo"
                type="number"
                min={1}
                max={720}
                value={s.demo.defaultHours}
                disabled={ro}
                onChange={(e) => set('demo', { defaultHours: Number(e.target.value) })}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Billing rules</CardTitle>
          <CardDescription>Apply to every business. Amounts are in {currency}.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Toggle
            id="st-withdraw"
            label="Allow wallet withdrawals"
            hint="Keep off until a legal review confirms payouts are allowed. Each request still needs your approval."
            checked={s.billing.withdrawalsEnabled}
            onChange={(v) => set('billing', { withdrawalsEnabled: v })}
            disabled={ro}
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Grace period (days)"
              htmlFor="st-grace"
              hint="After a failed renewal, before paid features stop."
              error={errs['billing.graceDays']}
            >
              <Input
                id="st-grace"
                type="number"
                min={0}
                max={30}
                value={s.billing.graceDays}
                disabled={ro}
                onChange={(e) => set('billing', { graceDays: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Tax rate (%)"
              htmlFor="st-tax"
              hint="0 for none. Shown on invoices."
              error={errs['billing.taxRateBps']}
            >
              <Input
                id="st-tax"
                inputMode="decimal"
                value={taxPct}
                disabled={ro}
                onChange={(e) => setTaxPct(e.target.value)}
              />
            </Field>
            <Field
              label="Tax name"
              htmlFor="st-tax-label"
              hint="E.g. VAT."
              error={errs['billing.taxLabel']}
            >
              <Input
                id="st-tax-label"
                maxLength={20}
                value={s.billing.taxLabel}
                disabled={ro}
                onChange={(e) => set('billing', { taxLabel: e.target.value })}
              />
            </Field>
            <div />
            <Field label="Smallest top-up" htmlFor="st-min" error={errs['billing.minTopupMinor']}>
              <Input
                id="st-min"
                inputMode="decimal"
                value={minTopup}
                disabled={ro}
                onChange={(e) => setMinTopup(e.target.value)}
              />
            </Field>
            <Field label="Largest top-up" htmlFor="st-max" error={errs['billing.maxTopupMinor']}>
              <Input
                id="st-max"
                inputMode="decimal"
                value={maxTopup}
                disabled={ro}
                onChange={(e) => setMaxTopup(e.target.value)}
              />
            </Field>
          </div>
          {!valid && (
            <p className="text-sm text-destructive">
              Check the tax rate (0 to 50, up to 2 decimals) and that the largest top-up is not
              below the smallest.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Maintenance</CardTitle>
          <CardDescription>
            Shows a notice to everyone. It does not stop the service.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Toggle
            id="st-maint"
            label="Show maintenance notice"
            checked={s.maintenance.enabled}
            onChange={(v) => set('maintenance', { enabled: v })}
            disabled={ro}
          />
          <Field
            label="Message"
            htmlFor="st-maint-msg"
            optional
            error={errs['maintenance.message']}
          >
            <Textarea
              id="st-maint-msg"
              rows={2}
              maxLength={500}
              value={s.maintenance.message}
              disabled={ro}
              onChange={(e) => set('maintenance', { message: e.target.value })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Support contacts</CardTitle>
          <CardDescription>Shown to businesses in the app and in emails.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Support email" htmlFor="st-email" error={errs['support.email']}>
            <Input
              id="st-email"
              type="email"
              value={s.support.email}
              disabled={ro}
              onChange={(e) => set('support', { email: e.target.value })}
            />
          </Field>
          <Field label="WhatsApp number" htmlFor="st-wa" optional error={errs['support.whatsapp']}>
            <Input
              id="st-wa"
              inputMode="tel"
              maxLength={32}
              value={s.support.whatsapp}
              disabled={ro}
              onChange={(e) => set('support', { whatsapp: e.target.value })}
            />
          </Field>
        </CardContent>
        {editable && (
          <CardFooter className="justify-between">
            <span className="text-muted-foreground">
              {initial.updatedAt
                ? `Last saved ${formatDateTime(initial.updatedAt)}`
                : 'Using defaults'}
            </span>
            <Button type="submit" loading={save.isPending} disabled={!valid}>
              Save settings
            </Button>
          </CardFooter>
        )}
      </Card>
    </form>
  );
}
