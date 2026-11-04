'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Building2, MessageSquareText, Plus, Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ColumnChart } from '@/components/charts/column-chart';
import { MoneyInput } from '@/components/commerce/money-input';
import { usePlatform } from '@/components/platform-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Switch } from '@/components/ui/switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  SmsBusinessList,
  SmsBusinessRow,
  SmsPlatform,
  SmsPlatformConnectResult,
  SmsPlatformOverview,
  SmsPlatformTest,
  SmsPrice,
  SmsSenderNameList,
  SmsSenderNameRow,
  SmsStats,
} from '@/lib/api/types';
import {
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelative,
  minorToInput,
  parseMoney,
} from '@/lib/format';
import { daysBetween, longDay, rangeFromDays, shortDay } from '@/lib/series';
import { FAILURE_HELP, STATUS_LABEL, smsLength } from '@/lib/sms';
import { cn } from '@/lib/utils';
import { GatewayDialog } from './gateway-dialog';

export const platformSmsKeys = {
  all: ['platform', 'sms'] as const,
  overview: () => [...platformSmsKeys.all, 'overview'] as const,
  stats: (from: string, to: string) => [...platformSmsKeys.all, 'stats', from, to] as const,
  senderNames: (status: string) => [...platformSmsKeys.all, 'sender-names', status] as const,
  /** The nav badge's count, kept apart so the list's filter does not change it. */
  pendingCount: () => [...platformSmsKeys.all, 'pending-count'] as const,
  businesses: () => [...platformSmsKeys.all, 'businesses'] as const,
};

export function useSmsOverview(enabled = true) {
  return useQuery({
    queryKey: platformSmsKeys.overview(),
    queryFn: () => api<SmsPlatformOverview>('/platform/sms'),
    enabled,
  });
}

function useSetPlatform() {
  const qc = useQueryClient();
  return (platform: SmsPlatform) =>
    qc.setQueryData<SmsPlatformOverview>(platformSmsKeys.overview(), (o) =>
      o ? { ...o, platform } : o,
    );
}

// ---------------------------------------------------------------- account

/** Sellora's own provider account: the one "Sellora SMS" sends through for every business. */
export function PlatformAccountCard({ overview }: { overview: SmsPlatformOverview }) {
  const { can } = usePlatform();
  const manage = can('platform.sms.manage');
  const setPlatform = useSetPlatform();
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const p = overview.platform;
  const connected = p.provider !== null;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<SmsPlatform>('/platform/sms', { method: 'PATCH', body: { enabled } }),
    onSuccess: (platform) => {
      setPlatform(platform);
      toast.success(
        platform.enabled ? 'Sellora SMS is on: businesses can choose it.' : 'Sellora SMS is off.',
      );
    },
  });

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Sellora’s SMS account</CardTitle>
          <CardDescription>
            Businesses that choose Sellora SMS send through this account and pay per part from their
            wallet cash.
          </CardDescription>
        </div>
        {connected && (
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch
              checked={p.enabled}
              disabled={!manage || toggle.isPending}
              onCheckedChange={(v) => toggle.mutate(v)}
              aria-label="Offer Sellora SMS to businesses"
            />
            {p.enabled ? 'Offered to businesses' : 'Switched off'}
          </label>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {!connected ? (
          <EmptyState icon={MessageSquareText} title="No SMS account connected">
            Connect a BulkSMSBD, Alpha SMS, SSL Wireless or Twilio account. Until then businesses
            can only send through their own accounts.
            {manage && (
              <div className="mt-3">
                <Button onClick={() => setConnecting(true)}>Connect an account</Button>
              </div>
            )}
          </EmptyState>
        ) : (
          <>
            {p.ready ? (
              <Alert tone="success">
                Businesses can choose Sellora SMS. Messages go out from{' '}
                <strong>{p.senderId || 'the provider’s default sender'}</strong>, or from a sender
                name you approved.
              </Alert>
            ) : (
              <Alert tone="warning">
                Switched off: businesses cannot choose Sellora SMS, and businesses already using it
                stop sending until it is back on.
              </Alert>
            )}
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4">
              <div className="space-y-1 text-sm">
                <p className="font-medium">{p.providerName}</p>
                <p className="text-muted-foreground">
                  {p.credentialsHint}
                  {p.senderId ? ` · sender ${p.senderId}` : ''}
                  {p.reach === 'bd_mobile' ? ' · Bangladeshi mobiles' : ' · any country'}
                </p>
                {p.lastCheck && (
                  <p className="text-[13px] text-muted-foreground">
                    {p.lastCheck.summary} Checked{' '}
                    <time dateTime={p.lastCheck.at} title={formatDateTime(p.lastCheck.at)}>
                      {formatRelative(p.lastCheck.at)}
                    </time>
                    .
                  </p>
                )}
              </div>
              {manage && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setConnecting(true)}>
                    Change
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Disconnect ${p.providerName}`}
                    onClick={() => setRemoving(true)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>

      <GatewayDialog
        open={connecting}
        onOpenChange={setConnecting}
        providers={overview.providers}
        current={
          p.provider
            ? { provider: p.provider, senderId: p.senderId, credentialsHint: p.credentialsHint }
            : null
        }
        title={connected ? 'Sellora’s SMS account' : 'Connect Sellora’s SMS account'}
        description="The API details from the provider’s panel. They are checked with the provider before saving, stored encrypted and never shown again."
        onSave={async (input, replace) => {
          if (replace) {
            const r = await api<SmsPlatformConnectResult>('/platform/sms/gateway', {
              method: 'PUT',
              body: input,
            });
            setPlatform(r.platform);
            toast.success(r.check.summary || 'Connected.');
          } else {
            setPlatform(
              await api<SmsPlatform>('/platform/sms', {
                method: 'PATCH',
                body: { senderId: input.senderId },
              }),
            );
            toast.success('Sender saved.');
          }
        }}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Disconnect ${p.providerName ?? 'the SMS account'}?`}
        description="Sellora SMS switches off and the saved API details are deleted. Businesses using Sellora SMS stop sending until you connect an account again."
        confirmLabel="Disconnect"
        destructive
        onConfirm={async () => {
          setPlatform(await api<SmsPlatform>('/platform/sms/gateway', { method: 'DELETE' }));
          toast.success('SMS account disconnected.');
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- prices

interface PriceRow {
  currency: string;
  price: string;
  senderPrice: string;
  cost: string;
  senderCost: string;
}

function toRows(p: SmsPlatform): PriceRow[] {
  const currencies = [...new Set([...p.prices, ...p.costs].map((x) => x.currency))];
  if (!currencies.length)
    return [{ currency: 'BDT', price: '', senderPrice: '', cost: '', senderCost: '' }];
  const input = (list: SmsPrice[], c: string, key: 'perPartMinor' | 'senderNamePerPartMinor') => {
    const row = list.find((x) => x.currency === c);
    return row ? minorToInput(row[key], c) : '';
  };
  return currencies.map((c) => ({
    currency: c,
    price: input(p.prices, c, 'perPartMinor'),
    senderPrice: input(p.prices, c, 'senderNamePerPartMinor'),
    cost: input(p.costs, c, 'perPartMinor'),
    senderCost: input(p.costs, c, 'senderNamePerPartMinor'),
  }));
}

/** What businesses pay per SMS part, and what the provider charges Sellora, per currency. */
export function PricesCard({ platform }: { platform: SmsPlatform }) {
  // Remount when the saved prices change, so the form starts from them.
  return <PricesForm key={JSON.stringify([platform.prices, platform.costs])} platform={platform} />;
}

function PricesForm({ platform }: { platform: SmsPlatform }) {
  const { can } = usePlatform();
  const manage = can('platform.sms.manage');
  const setPlatform = useSetPlatform();
  const initial = useMemo(() => toRows(platform), [platform]);
  const [rows, setRows] = useState<PriceRow[]>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial);

  const parsed = rows.map((r) => {
    const c = r.currency.trim().toUpperCase();
    const valid = /^[A-Z]{3}$/.test(c);
    const m = (v: string) => (valid ? parseMoney(v.trim(), c) : null);
    return {
      currency: c,
      valid,
      price: m(r.price),
      senderPrice: m(r.senderPrice),
      cost: m(r.cost),
      senderCost: m(r.senderCost),
    };
  });
  const problems: Record<string, string> = {};
  const seen = new Set<string>();
  parsed.forEach((r, i) => {
    if (!r.valid) problems[`${i}.currency`] = 'Three letters, like BDT';
    else if (seen.has(r.currency)) problems[`${i}.currency`] = 'One row per currency';
    seen.add(r.currency);
    for (const k of ['price', 'senderPrice', 'cost', 'senderCost'] as const)
      if (r.valid && r[k] === null) problems[`${i}.${k}`] = 'Amount';
  });
  const invalid = Object.keys(problems).length > 0;

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<SmsPlatform>('/platform/sms', {
        method: 'PATCH',
        body: {
          prices: parsed.map((r) => ({
            currency: r.currency,
            perPartMinor: r.price!,
            senderNamePerPartMinor: r.senderPrice!,
          })),
          costs: parsed.map((r) => ({
            currency: r.currency,
            perPartMinor: r.cost!,
            senderNamePerPartMinor: r.senderCost!,
          })),
        },
      }),
    onSuccess: (p) => {
      setPlatform(p);
      toast.success('SMS prices saved.');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      else toast.error(errorMessage(err));
    },
  });

  const set = (i: number, patch: Partial<PriceRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Prices and costs</CardTitle>
        <CardDescription>
          Per SMS part (160 English or 70 Bangla characters). Businesses see only the price; the
          cost is what the provider charges Sellora and drives the profit report. A business whose
          currency has no row cannot use Sellora SMS.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {errors.prices && <Alert tone="danger">{errors.prices}</Alert>}
        {rows.map((r, i) => {
          const p = parsed[i]!;
          const loss =
            (p.price !== null && p.cost !== null && p.price < p.cost) ||
            (p.senderPrice !== null && p.senderCost !== null && p.senderPrice < p.senderCost);
          const money = (key: keyof PriceRow, label: string, id: string) => (
            <Field
              label={label}
              htmlFor={id}
              error={problems[`${i}.${key}`] && rows[i]![key] ? problems[`${i}.${key}`] : undefined}
            >
              <MoneyInput
                id={id}
                currency={p.valid ? p.currency : 'BDT'}
                value={r[key]}
                disabled={!manage}
                placeholder="0.00"
                onChange={(e) => set(i, { [key]: e.target.value })}
              />
            </Field>
          );
          return (
            <fieldset key={i} className="grid gap-3 rounded-lg border p-4">
              <legend className="sr-only">Prices in {r.currency || 'a new currency'}</legend>
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label="Currency"
                  htmlFor={`sp-cur-${i}`}
                  error={problems[`${i}.currency`]}
                  className="w-28"
                >
                  <Input
                    id={`sp-cur-${i}`}
                    value={r.currency}
                    maxLength={3}
                    disabled={!manage}
                    className="uppercase"
                    onChange={(e) => set(i, { currency: e.target.value.toUpperCase() })}
                  />
                </Field>
                {manage && rows.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    aria-label={`Remove ${r.currency || 'this'} row`}
                    onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {money('price', 'Price, shared sender', `sp-p-${i}`)}
                {money('cost', 'Our cost, shared sender', `sp-c-${i}`)}
                {money('senderPrice', 'Price, sender name', `sp-sp-${i}`)}
                {money('senderCost', 'Our cost, sender name', `sp-sc-${i}`)}
              </div>
              {p.valid && <Margins p={p} />}
              {loss && (
                <Alert tone="warning">
                  A price is below its cost: Sellora loses money on every part sent.
                </Alert>
              )}
            </fieldset>
          );
        })}
        {manage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setRows((rs) => [
                  ...rs,
                  { currency: '', price: '', senderPrice: '', cost: '', senderCost: '' },
                ])
              }
            >
              <Plus aria-hidden /> Add a currency
            </Button>
            <div className="ml-auto flex gap-2">
              {dirty && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setRows(initial);
                    setErrors({});
                  }}
                >
                  Undo
                </Button>
              )}
              <Button
                loading={save.isPending}
                disabled={!dirty || invalid}
                onClick={() => {
                  setErrors({});
                  save.mutate();
                }}
              >
                Save prices
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Margins({
  p,
}: {
  p: {
    currency: string;
    price: number | null;
    senderPrice: number | null;
    cost: number | null;
    senderCost: number | null;
  };
}) {
  const line = (label: string, price: number | null, cost: number | null) => {
    if (price === null || cost === null) return null;
    const profit = price - cost;
    return (
      <span>
        {label}:{' '}
        <strong className={cn(profit < 0 && 'text-danger')}>
          {formatMoney(profit, p.currency, { signed: true })}
        </strong>{' '}
        per part{price > 0 ? ` (${Math.round((profit / price) * 100)}%)` : ''}
      </span>
    );
  };
  const a = line('Shared sender', p.price, p.cost);
  const b = line('Sender name', p.senderPrice, p.senderCost);
  if (!a && !b) return null;
  return (
    <p className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted-foreground">
      {a}
      {b}
    </p>
  );
}

// ---------------------------------------------------------------- test

/** One message from Sellora's account to a number the admin owns. No business pays for it. */
export function PlatformTestCard() {
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SmsPlatformTest | null>(null);
  const send = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<SmsPlatformTest>('/platform/sms/test', {
        body: { to: to.trim(), ...(text.trim() ? { text: text.trim() } : {}) },
      }),
    onSuccess: setResult,
    onError: (err) =>
      setError(
        err instanceof ApiError ? (err.fieldErrors().to ?? errorMessage(err)) : errorMessage(err),
      ),
  });
  const parts = smsLength(text).parts;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Send a test</CardTitle>
        <CardDescription>
          Goes out straight away from Sellora’s account. No business is charged.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            setResult(null);
            send.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
            <Field label="Phone number" htmlFor="pst-to" error={error ?? undefined}>
              <Input
                id="pst-to"
                inputMode="tel"
                placeholder="01712345678"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Field
              label="Message"
              htmlFor="pst-text"
              optional
              hint={
                text ? `${parts} part${parts === 1 ? '' : 's'}` : 'Empty sends a short test text.'
              }
            >
              <Textarea
                id="pst-text"
                rows={2}
                maxLength={300}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={send.isPending} disabled={!to.trim()}>
              <Send aria-hidden /> Send test
            </Button>
            {result &&
              (result.ok ? (
                <span role="status" className="text-sm text-success">
                  {result.providerName} accepted it ({result.providerStatus}
                  {result.providerMessageId ? `, id ${result.providerMessageId}` : ''}).
                </span>
              ) : (
                <span role="status" className="text-danger text-sm">
                  {result.providerName}: {result.error} {FAILURE_HELP[result.failure]}
                </span>
              ))}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- stats

const RANGES = ['7', '30', '90'] as const;

/** Sellora SMS money by day, and how all messages ended. */
export function StatsCard() {
  const [days, setDays] = useState<(typeof RANGES)[number]>('30');
  const range = useMemo(() => rangeFromDays(Number(days)), [days]);
  const stats = useQuery({
    queryKey: platformSmsKeys.stats(range.from, range.to),
    queryFn: () => api<SmsStats>('/platform/sms/stats', { query: range }),
    placeholderData: keepPreviousData,
  });

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Sellora SMS revenue</CardTitle>
          <CardDescription>
            What businesses paid for Sellora SMS against what the provider charged.
            {stats.data ? ` Days are cut in ${stats.data.timezone}.` : ''}
          </CardDescription>
        </div>
        <Segmented
          label="Period"
          value={days}
          onChange={setDays}
          options={RANGES.map((r) => ({ value: r, label: `${r} days` }))}
        />
      </CardHeader>
      <CardContent className={cn('grid gap-5', stats.isPlaceholderData && 'opacity-60')}>
        {stats.isPending ? (
          <Skeleton className="h-64" />
        ) : stats.isError ? (
          <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
        ) : stats.data.totals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Sellora SMS were charged in this period.
          </p>
        ) : (
          <>
            {stats.data.totals.map((t) => (
              <div key={t.currency} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Messages"
                  value={formatNumber(t.messages)}
                  sub={`${formatNumber(t.parts)} parts`}
                />
                <Stat label="Paid by businesses" value={formatMoney(t.revenueMinor, t.currency)} />
                <Stat label="Provider cost" value={formatMoney(t.costMinor, t.currency)} />
                <Stat
                  label="Profit"
                  value={formatMoney(t.profitMinor, t.currency, { signed: true })}
                  sub={
                    t.revenueMinor > 0
                      ? `${Math.round((t.profitMinor / t.revenueMinor) * 100)}% margin`
                      : undefined
                  }
                />
              </div>
            ))}
            <ColumnChart
              label="Day"
              data={daysBetween(stats.data.from, stats.data.to, stats.data.timezone).map((key) => {
                const cur = stats.data.totals[0]!.currency;
                const r = stats.data.days.find((d) => d.day === key && d.currency === cur);
                return { key, values: [r?.costMinor ?? 0, Math.max(0, r?.profitMinor ?? 0)] };
              })}
              series={[
                { name: 'Provider cost', color: '--series-2' },
                { name: 'Profit', color: '--series-1' },
              ]}
              formatValue={(n) => formatMoney(n, stats.data.totals[0]!.currency)}
              formatTick={(n) => formatMoney(n, stats.data.totals[0]!.currency, { compact: true })}
              formatKey={shortDay}
              formatKeyLong={longDay}
            />
          </>
        )}
        {stats.data && stats.data.byStatus.length > 0 && <StatusTable rows={stats.data.byStatus} />}
      </CardContent>
    </Card>
  );
}

function StatusTable({ rows }: { rows: SmsStats['byStatus'] }) {
  const statuses = (
    ['delivered', 'sent', 'queued', 'sending', 'unknown', 'failed'] as const
  ).filter((s) => rows.some((r) => r.status === s));
  const routes = ['sellora', 'own'].filter((route) => rows.some((r) => r.route === route));
  const count = (route: string, status: string) =>
    rows.find((r) => r.route === route && r.status === status)?.count ?? 0;
  return (
    <div>
      <p className="mb-2 text-sm font-medium">How messages ended</p>
      <Table>
        <THead>
          <TR>
            <TH>Sent through</TH>
            {statuses.map((s) => (
              <TH key={s} className="text-right">
                {STATUS_LABEL[s].label}
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {routes.map((route) => (
            <TR key={route}>
              <TD>{route === 'sellora' ? 'Sellora SMS' : 'Businesses’ own accounts'}</TD>
              {statuses.map((s) => (
                <TD key={s} className="tabular text-right">
                  {formatNumber(count(route, s))}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------- sender names

type NameFilter = 'pending' | 'approved' | 'rejected' | 'all';

const NAME_TONE = { pending: 'warning', approved: 'success', rejected: 'danger' } as const;
const NAME_LABEL = { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected' } as const;

/** Sender names (masking) businesses asked for. Approve after registering them with the provider. */
export function SenderNamesCard() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<NameFilter>('pending');
  const [deciding, setDeciding] = useState<{ row: SmsSenderNameRow; approve: boolean } | null>(
    null,
  );
  const list = useQuery({
    queryKey: platformSmsKeys.senderNames(status),
    queryFn: () => api<SmsSenderNameList>('/platform/sms/sender-names', { query: { status } }),
    placeholderData: keepPreviousData,
  });

  const decide = async (row: SmsSenderNameRow, approve: boolean, reason: string) => {
    try {
      await api(`/platform/sms/sender-names/${row.orgId}/${approve ? 'approve' : 'reject'}`, {
        body: approve ? { name: row.name } : { name: row.name, reason },
      });
      toast.success(
        approve
          ? `${row.name} approved. The business was emailed.`
          : `${row.name} rejected. The business was emailed the reason.`,
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.code === 'sender_name_changed'
          ? 'The business changed its request meanwhile. The list is updated.'
          : errorMessage(err),
      );
      if (!(err instanceof ApiError && err.status === 409)) throw err;
    } finally {
      void qc.invalidateQueries({ queryKey: platformSmsKeys.all });
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Sender names</CardTitle>
          <CardDescription>
            A sender name shows the shop’s name instead of a number. Register it with Sellora’s SMS
            provider first: messages from an unregistered name are refused.
          </CardDescription>
        </div>
        <Segmented<NameFilter>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: 'Waiting' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'all', label: 'All' },
          ]}
        />
      </CardHeader>
      <CardContent className={cn('px-0 pb-0', list.isPlaceholderData && 'opacity-60')}>
        {list.isPending ? (
          <Skeleton className="m-5 h-32" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState
            icon={BadgeCheck}
            title={status === 'pending' ? 'No sender names waiting' : 'None yet'}
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Business</TH>
                <TH>Name</TH>
                <TH>Status</TH>
                <TH>Asked</TH>
                <TH className="text-right">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {list.data.items.map((r) => (
                <TR key={`${r.orgId}-${r.name}`}>
                  <TD>
                    <Link
                      href={`/admin/tenants/${r.orgId}`}
                      className="font-medium hover:underline"
                    >
                      {r.business?.name ?? r.orgId}
                    </Link>
                  </TD>
                  <TD className="font-mono text-[13px]">{r.name}</TD>
                  <TD>
                    <Badge tone={NAME_TONE[r.status]}>{NAME_LABEL[r.status]}</Badge>
                    {r.inUse && (
                      <Badge tone="outline" className="ml-1.5">
                        In use
                      </Badge>
                    )}
                    {r.reason && (
                      <span className="mt-1 block text-xs text-muted-foreground">{r.reason}</span>
                    )}
                  </TD>
                  <TD
                    className="whitespace-nowrap text-muted-foreground"
                    title={formatDateTime(r.requestedAt)}
                  >
                    {formatRelative(r.requestedAt)}
                  </TD>
                  <TD className="text-right whitespace-nowrap">
                    {r.status === 'pending' && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => setDeciding({ row: r, approve: true })}>
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDeciding({ row: r, approve: false })}
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
      <ConfirmDialog
        open={deciding !== null}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={
          deciding?.approve
            ? `Approve ${deciding.row.name}?`
            : `Reject ${deciding?.row.name ?? 'this name'}?`
        }
        description={
          deciding?.approve
            ? `${deciding.row.business?.name ?? 'The business'} can then send from ${deciding.row.name} at the sender-name price. Approve only once the provider has registered it.`
            : 'The business is emailed the reason and can ask for another name.'
        }
        confirmLabel={deciding?.approve ? 'Approve' : 'Reject'}
        destructive={deciding ? !deciding.approve : false}
        reason={deciding ? !deciding.approve : false}
        reasonLabel="Reason the business will see"
        onConfirm={(reason) =>
          deciding ? decide(deciding.row, deciding.approve, reason) : undefined
        }
      />
    </Card>
  );
}

// ---------------------------------------------------------------- businesses

const MODE_LABEL = { off: 'Off', sellora: 'Sellora SMS', own: 'Own account' } as const;

/** Businesses that set SMS up, their last 30 days and the daily limit that protects wallets. */
export function BusinessesCard() {
  const { can } = usePlatform();
  const manage = can('platform.sms.manage');
  const [editing, setEditing] = useState<SmsBusinessRow | null>(null);
  const list = useQuery({
    queryKey: platformSmsKeys.businesses(),
    queryFn: () => api<SmsBusinessList>('/platform/sms/businesses'),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Businesses</CardTitle>
        <CardDescription>
          Businesses that opened Settings › SMS. The daily limit stops a mistake from emptying a
          wallet; it applies to every route.
          {list.data ? ` The default is ${formatNumber(list.data.defaultDailyLimit)} a day.` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {list.isPending ? (
          <Skeleton className="m-5 h-32" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState icon={Building2} title="No business has set SMS up yet" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Business</TH>
                <TH>Sends through</TH>
                <TH className="text-right">Last 30 days</TH>
                <TH className="text-right">Spent</TH>
                <TH className="text-right">Daily limit</TH>
              </TR>
            </THead>
            <TBody>
              {list.data.items.map((b) => (
                <TR key={b.orgId}>
                  <TD>
                    <Link
                      href={`/admin/tenants/${b.orgId}`}
                      className="font-medium hover:underline"
                    >
                      {b.business?.name ?? b.orgId}
                    </Link>
                  </TD>
                  <TD>
                    {MODE_LABEL[b.mode]}
                    {b.mode === 'own' && b.ownProvider && (
                      <span className="text-muted-foreground"> · {b.ownProvider}</span>
                    )}
                    {b.senderName && (
                      <span className="block font-mono text-xs text-muted-foreground">
                        {b.senderName}
                      </span>
                    )}
                  </TD>
                  <TD className="tabular text-right">
                    {formatNumber(b.last30Days.messages)}
                    {b.last30Days.failed > 0 && (
                      <span className="text-danger block text-xs">
                        {formatNumber(b.last30Days.failed)} failed
                      </span>
                    )}
                  </TD>
                  <TD className="tabular text-right">
                    {b.business
                      ? formatMoney(b.last30Days.spentMinor, b.business.currency)
                      : formatNumber(b.last30Days.spentMinor)}
                  </TD>
                  <TD className="tabular text-right whitespace-nowrap">
                    {formatNumber(b.effectiveDailyLimit)}
                    {b.dailyLimit === null && (
                      <span className="text-xs text-muted-foreground"> (default)</span>
                    )}
                    {manage && (
                      <Button
                        variant="link"
                        size="sm"
                        className="ml-2"
                        onClick={() => setEditing(b)}
                      >
                        Change
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
      {list.data && (
        <DailyLimitDialog
          row={editing}
          defaultLimit={list.data.defaultDailyLimit}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function DailyLimitDialog({
  row,
  defaultLimit,
  onClose,
}: {
  row: SmsBusinessRow | null;
  defaultLimit: number;
  onClose: () => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Daily SMS limit"
        description={
          row ? `For ${row.business?.name ?? 'this business'}, counted per day in all routes.` : ''
        }
      >
        {row && (
          <DailyLimitForm key={row.orgId} row={row} defaultLimit={defaultLimit} onDone={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DailyLimitForm({
  row,
  defaultLimit,
  onDone,
}: {
  row: SmsBusinessRow;
  defaultLimit: number;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [useDefault, setUseDefault] = useState(row.dailyLimit === null);
  const [value, setValue] = useState(String(row.dailyLimit ?? defaultLimit));
  const n = Number(value);
  const invalid = !useDefault && (!/^\d+$/.test(value.trim()) || n > 1_000_000);
  const save = useMutation({
    mutationFn: () =>
      api(`/platform/sms/businesses/${row.orgId}/daily-limit`, {
        method: 'PUT',
        body: { dailyLimit: useDefault ? null : n },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: platformSmsKeys.businesses() });
      toast.success('Daily limit saved.');
      onDone();
    },
  });
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) save.mutate();
      }}
    >
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={useDefault} onCheckedChange={(v) => setUseDefault(v === true)} />
        Use the default ({formatNumber(defaultLimit)} a day)
      </label>
      {!useDefault && (
        <Field
          label="Messages a day"
          htmlFor="sms-limit"
          error={invalid ? 'A whole number up to 1,000,000' : undefined}
          hint="0 stops all SMS for this business."
        >
          <Input
            id="sms-limit"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending} disabled={invalid}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
