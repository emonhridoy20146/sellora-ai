'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { INTERVAL_LABEL } from '@/components/billing/labels';
import { usePlatform } from '@/components/platform-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Field, Label } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  BillingInterval,
  ModuleCatalogue,
  PlanLimits,
  PlatformCreditRate,
  PlatformPlan,
} from '@/lib/api/types';
import { formatMoney, formatNumber, formatRelative, minorToInput, parseMoney } from '@/lib/format';

const LIMIT_LABEL: Record<keyof PlanLimits, { label: string; unit?: string }> = {
  seats: { label: 'Staff seats' },
  stores: { label: 'Online stores' },
  products: { label: 'Products' },
  channels: { label: 'Connected channels' },
  ordersPerMonth: { label: 'Orders per month' },
  conversationsPerMonth: { label: 'Conversations per month' },
  landingPages: { label: 'Landing pages' },
  storageMb: { label: 'File storage', unit: 'MB' },
};

const INTERVALS: BillingInterval[] = ['month', 'year', 'lifetime'];

export default function PlansPage() {
  const { can } = usePlatform();
  const [editing, setEditing] = useState<PlatformPlan | 'new' | null>(null);
  const plans = useQuery({
    queryKey: ['platform', 'plans'],
    queryFn: () => api<PlatformPlan[]>('/platform/billing/plans'),
  });
  const manage = can('platform.plans.manage');

  return (
    <>
      <PageHeader
        title="Plans"
        description="What each plan includes and costs. Businesses keep the price they signed up at until they change plan."
        actions={
          manage && (
            <Button onClick={() => setEditing('new')}>
              <Plus /> New plan
            </Button>
          )
        }
      />
      <Card>
        <CardContent className="px-0 py-0">
          {plans.isPending ? (
            <Skeleton className="m-5 h-40" />
          ) : plans.isError ? (
            <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
          ) : plans.data.length === 0 ? (
            <EmptyState icon={Layers} title="No plans yet">
              Create the first plan businesses can pick.
            </EmptyState>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Plan</TH>
                  <TH>Prices</TH>
                  <TH className="text-right">Modules</TH>
                  <TH className="text-right">AI credits / month</TH>
                  <TH>Visibility</TH>
                  <TH>Changed</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {[...plans.data]
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((p) => (
                    <TR key={p.id}>
                      <TD>
                        <span className="flex items-center gap-1.5 font-medium">
                          {p.name}
                          {p.highlight && (
                            <Star
                              className="size-3.5 fill-current text-warning"
                              aria-label="Highlighted"
                            />
                          )}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {p.code} · v{p.version}
                        </span>
                      </TD>
                      <TD>
                        {p.prices.length === 0 ? (
                          <span className="text-muted-foreground">Free</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {p.prices.map((pr) => (
                              <li
                                key={`${pr.interval}-${pr.currency}`}
                                className="tabular whitespace-nowrap"
                              >
                                {formatMoney(pr.amountMinor, pr.currency)}{' '}
                                <span className="text-muted-foreground">
                                  {INTERVAL_LABEL[pr.interval]?.toLowerCase()}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TD>
                      <TD className="tabular text-right">{p.modules.length}</TD>
                      <TD className="tabular text-right">
                        {formatNumber(p.includedCreditsPerMonth)}
                      </TD>
                      <TD>
                        <span className="inline-flex flex-wrap gap-1">
                          {!p.isActive ? (
                            <Badge>Retired</Badge>
                          ) : p.isPublic ? (
                            <Badge tone="success">Public</Badge>
                          ) : (
                            <Badge tone="outline">Hidden</Badge>
                          )}
                          {p.trialEligible && <Badge tone="info">Trial</Badge>}
                        </span>
                      </TD>
                      <TD className="whitespace-nowrap text-muted-foreground">
                        {formatRelative(p.updatedAt)}
                      </TD>
                      <TD className="text-right">
                        {manage && (
                          <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                            <Pencil /> Edit
                          </Button>
                        )}
                      </TD>
                    </TR>
                  ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {editing && (
        <PlanEditor
          plan={editing === 'new' ? null : editing}
          fallbackCurrency={plans.data?.flatMap((p) => p.prices)[0]?.currency}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

interface PriceRow {
  id: string;
  interval: BillingInterval;
  currency: string;
  amount: string;
}

function PlanEditor({
  plan,
  fallbackCurrency,
  onClose,
}: {
  plan: PlatformPlan | null;
  fallbackCurrency?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const catalogue = useQuery({
    queryKey: ['platform', 'modules'],
    queryFn: () => api<ModuleCatalogue>('/platform/billing/modules'),
    staleTime: Infinity,
  });
  const rates = useQuery({
    queryKey: ['platform', 'credit-rates'],
    queryFn: () => api<PlatformCreditRate[]>('/platform/billing/credit-rates'),
    enabled: !fallbackCurrency,
  });
  const defaultCurrency = fallbackCurrency ?? rates.data?.[0]?.currency ?? '';

  const [code, setCode] = useState(plan?.code ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [modules, setModules] = useState<Set<string>>(
    () => new Set(plan?.modules.map((m) => m.key) ?? []),
  );
  const [limits, setLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(plan?.limits ?? {}).map(([k, v]) => [
        k,
        v === null || v === undefined ? '' : String(v),
      ]),
    ),
  );
  const [prices, setPrices] = useState<PriceRow[]>(() =>
    (plan?.prices ?? []).map((p) => ({
      id: `${p.interval}-${p.currency}`,
      interval: p.interval,
      currency: p.currency,
      amount: minorToInput(p.amountMinor, p.currency),
    })),
  );
  const [credits, setCredits] = useState(String(plan?.includedCreditsPerMonth ?? 0));
  const [flags, setFlags] = useState({
    isPublic: plan?.isPublic ?? true,
    isActive: plan?.isActive ?? true,
    trialEligible: plan?.trialEligible ?? true,
    highlight: plan?.highlight ?? false,
  });
  const [sortOrder, setSortOrder] = useState(String(plan?.sortOrder ?? 100));

  const parsedPrices = prices.map((p) => ({
    interval: p.interval,
    currency: p.currency.trim().toUpperCase(),
    amountMinor: parseMoney(p.amount, p.currency.trim().toUpperCase() || 'USD'),
  }));
  const pricesValid = parsedPrices.every(
    (p) => /^[A-Z]{3}$/.test(p.currency) && p.amountMinor !== null,
  );
  const limitsValid = Object.values(limits).every((v) => v.trim() === '' || /^\d+$/.test(v.trim()));

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim(),
        modules: [...modules],
        limits: Object.fromEntries(
          (catalogue.data?.limits ?? []).map((k) => {
            const v = (limits[k] ?? '').trim();
            return [k, v === '' ? null : Number(v)];
          }),
        ),
        prices: parsedPrices.map((p) => ({ ...p, amountMinor: p.amountMinor ?? 0 })),
        includedCreditsPerMonth: Number(credits) || 0,
        ...flags,
        sortOrder: Number(sortOrder) || 0,
      };
      return plan
        ? api<PlatformPlan>(`/platform/billing/plans/${plan.code}`, { method: 'PATCH', body })
        : api<PlatformPlan>('/platform/billing/plans', {
            method: 'POST',
            body: { ...body, code: code.trim() },
          });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['platform', 'plans'] });
      toast.success(plan ? 'Plan saved.' : 'Plan created.');
      onClose();
    },
  });
  const errs: Record<string, string> =
    save.error instanceof ApiError ? save.error.fieldErrors() : {};

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        wide
        title={plan ? `Edit ${plan.name}` : 'New plan'}
        description={
          plan
            ? 'Changes apply to new sign-ups and plan changes. Current subscribers keep their price until they switch.'
            : 'Businesses see public, active plans on the pricing page and in billing.'
        }
      >
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="pl-name" error={errs.name}>
              <Input
                id="pl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                required
              />
            </Field>
            <Field
              label="Code"
              htmlFor="pl-code"
              error={errs.code}
              hint={
                plan ? 'Codes cannot change.' : 'Lowercase letters, digits and dashes, e.g. growth.'
              }
            >
              <Input
                id="pl-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toLowerCase())}
                disabled={Boolean(plan)}
                pattern="[a-z0-9][a-z0-9-]{0,39}"
                className="font-mono"
                required
              />
            </Field>
          </div>
          <Field label="Description" htmlFor="pl-desc" optional error={errs.description}>
            <Textarea
              id="pl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </Field>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Prices</legend>
            {prices.length === 0 && (
              <p className="text-sm text-muted-foreground">No prices: the plan is free.</p>
            )}
            {prices.map((p, i) => (
              <div key={p.id} className="grid grid-cols-[1fr_5.5rem_1fr_auto] items-end gap-2">
                <div>
                  <Label htmlFor={`pr-int-${p.id}`} className="sr-only">
                    Billing period
                  </Label>
                  <NativeSelect
                    id={`pr-int-${p.id}`}
                    value={p.interval}
                    onChange={(e) =>
                      setPrices((rows) =>
                        rows.map((r) =>
                          r.id === p.id ? { ...r, interval: e.target.value as BillingInterval } : r,
                        ),
                      )
                    }
                  >
                    {INTERVALS.map((iv) => (
                      <option key={iv} value={iv}>
                        {INTERVAL_LABEL[iv]}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div>
                  <Label htmlFor={`pr-cur-${p.id}`} className="sr-only">
                    Currency
                  </Label>
                  <Input
                    id={`pr-cur-${p.id}`}
                    value={p.currency}
                    maxLength={3}
                    className="font-mono uppercase"
                    aria-invalid={!/^[A-Za-z]{3}$/.test(p.currency.trim())}
                    onChange={(e) =>
                      setPrices((rows) =>
                        rows.map((r) =>
                          r.id === p.id ? { ...r, currency: e.target.value.toUpperCase() } : r,
                        ),
                      )
                    }
                  />
                </div>
                <div>
                  <Label htmlFor={`pr-amt-${p.id}`} className="sr-only">
                    Amount
                  </Label>
                  <Input
                    id={`pr-amt-${p.id}`}
                    inputMode="decimal"
                    value={p.amount}
                    aria-invalid={parsedPrices[i]?.amountMinor === null}
                    onChange={(e) =>
                      setPrices((rows) =>
                        rows.map((r) => (r.id === p.id ? { ...r, amount: e.target.value } : r)),
                      )
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove price"
                  onClick={() => setPrices((rows) => rows.filter((r) => r.id !== p.id))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            {errs.prices && <p className="text-sm text-destructive">{errs.prices}</p>}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setPrices((rows) => [
                    ...rows,
                    {
                      id: crypto.randomUUID(),
                      interval:
                        INTERVALS.find((iv) => !rows.some((r) => r.interval === iv)) ?? 'month',
                      currency: rows[0]?.currency ?? defaultCurrency,
                      amount: '',
                    },
                  ])
                }
              >
                <Plus /> Add price
              </Button>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-medium">Included modules</legend>
            {catalogue.isPending ? (
              <Skeleton className="h-24" />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {catalogue.data?.modules.map((m) => (
                  <label
                    key={m.key}
                    htmlFor={`mod-${m.key}`}
                    className="flex cursor-pointer gap-2.5 rounded-md border px-3 py-2 text-sm has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-info-soft/40"
                  >
                    <Checkbox
                      id={`mod-${m.key}`}
                      className="mt-0.5"
                      checked={modules.has(m.key)}
                      onCheckedChange={(c) =>
                        setModules((s) => {
                          const n = new Set(s);
                          if (c === true) n.add(m.key);
                          else n.delete(m.key);
                          return n;
                        })
                      }
                    />
                    <span>
                      <span className="block font-medium">{m.name}</span>
                      <span className="text-xs text-muted-foreground">{m.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset>
            <legend className="mb-1 text-sm font-medium">Limits</legend>
            <p className="mb-2 text-xs text-muted-foreground">Leave empty for unlimited.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(catalogue.data?.limits ?? []).map((k) => (
                <Field
                  key={k}
                  label={`${LIMIT_LABEL[k]?.label ?? k}${LIMIT_LABEL[k]?.unit ? ` (${LIMIT_LABEL[k].unit})` : ''}`}
                  htmlFor={`lim-${k}`}
                  error={errs[`limits.${k}`]}
                >
                  <Input
                    id={`lim-${k}`}
                    inputMode="numeric"
                    placeholder="Unlimited"
                    value={limits[k] ?? ''}
                    aria-invalid={
                      (limits[k] ?? '').trim() !== '' && !/^\d+$/.test((limits[k] ?? '').trim())
                    }
                    onChange={(e) => setLimits((s) => ({ ...s, [k]: e.target.value }))}
                  />
                </Field>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Free AI credits each month"
              htmlFor="pl-credits"
              hint="Added to the wallet as free credit (AI only, not withdrawable)."
              error={errs.includedCreditsPerMonth}
            >
              <Input
                id="pl-credits"
                type="number"
                min={0}
                max={1_000_000}
                value={credits}
                onChange={(e) => setCredits(e.target.value)}
              />
            </Field>
            <Field
              label="Order on the pricing page"
              htmlFor="pl-sort"
              hint="Lower comes first."
              error={errs.sortOrder}
            >
              <Input
                id="pl-sort"
                type="number"
                min={0}
                max={10_000}
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ['isActive', 'Available', 'Off retires the plan: no new subscriptions.'],
                [
                  'isPublic',
                  'Shown on the pricing page',
                  'Hidden plans can still be assigned by an admin.',
                ],
                ['trialEligible', 'Can be used for the free trial', ''],
                ['highlight', 'Highlight as recommended', ''],
              ] as const
            ).map(([key, label, hint]) => (
              <div
                key={key}
                className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
              >
                <span className="text-sm">
                  <label htmlFor={`fl-${key}`} className="font-medium">
                    {label}
                  </label>
                  {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
                </span>
                <Switch
                  id={`fl-${key}`}
                  checked={flags[key]}
                  onCheckedChange={(c) => setFlags((f) => ({ ...f, [key]: c }))}
                />
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={save.isPending}
              disabled={!name.trim() || !code.trim() || !pricesValid || !limitsValid}
            >
              {plan ? 'Save plan' : 'Create plan'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
