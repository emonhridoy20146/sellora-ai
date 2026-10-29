'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquareText, Send, ShieldOff, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { SmsMessage, SmsMessageStatus, SmsSettings } from '@/lib/api/types';
import { formatDateTime, formatMoney, formatNumber, formatRelative } from '@/lib/format';
import { FAILURE_HELP, PURPOSE_LABEL, STATUS_LABEL, localPhone, smsLength } from '@/lib/sms';
import { smsKeys, useSmsMessages, useSmsOptOuts, useSmsSummary } from './data';

export function StatusBadge({ m }: { m: Pick<SmsMessage, 'status'> }) {
  const s = STATUS_LABEL[m.status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Sends one message now, the way order messages go, and shows what the provider said. */
export function TestCard({ s }: { s: SmsSettings }) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SmsMessage | null>(null);
  const send = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<SmsMessage>(`/orgs/${org.id}/sms/test`, {
        body: { to: to.trim(), ...(text.trim() ? { text: text.trim() } : {}) },
      }),
    onSuccess: (m) => {
      setResult(m);
      void qc.invalidateQueries({ queryKey: smsKeys.all(org.id) });
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? (err.fieldErrors().to ?? errorMessage(err)) : errorMessage(err),
      ),
  });
  const length = smsLength(text);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send a test</CardTitle>
        <CardDescription>
          {s.mode === 'off'
            ? 'Choose how SMS go out first.'
            : s.route.ready && s.route.pricePerPartMinor > 0
              ? `Goes out like an order message and is charged ${formatMoney(s.route.pricePerPartMinor, s.route.currency)} per part.`
              : 'Goes out like an order message, through your own SMS account.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            setResult(null);
            send.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_1fr]">
            <Field label="Phone" htmlFor="sms-test-to" error={error ?? undefined}>
              <Input
                id="sms-test-to"
                inputMode="tel"
                placeholder="01712345678"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Field
              label="Message"
              htmlFor="sms-test-text"
              optional
              hint={
                text
                  ? `${length.parts} part${length.parts === 1 ? '' : 's'} · ${length.remaining} characters left`
                  : 'Empty sends a short test line with your shop name.'
              }
            >
              <Textarea
                id="sms-test-text"
                rows={2}
                maxLength={480}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              loading={send.isPending}
              disabled={s.mode === 'off' || !to.trim()}
            >
              <Send aria-hidden /> Send test
            </Button>
            {result && (
              <span className="flex flex-wrap items-center gap-2 text-sm" role="status">
                <StatusBadge m={result} />
                {result.status === 'sent' || result.status === 'delivered'
                  ? `Sent to ${localPhone(result.to)} through ${result.providerName}${result.priceMinor ? ` · ${formatMoney(result.priceMinor, result.currency)}` : ''}.`
                  : (result.error ?? (result.failure ? FAILURE_HELP[result.failure] : ''))}
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const FILTERS: { value: SmsMessageStatus | ''; label: string }[] = [
  { value: '', label: 'All messages' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
  { value: 'unknown', label: 'Unknown' },
  { value: 'queued', label: 'Waiting' },
];

/** The last 30 days at a glance, then every message, newest first. */
export function MessagesCard() {
  const { org } = useOrg();
  const [status, setStatus] = useState<SmsMessageStatus | ''>('');
  const summary = useSmsSummary(org.id);
  const q = useSmsMessages(org.id, { status }, { refetchInterval: 15_000 });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const sm = summary.data;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Messages</CardTitle>
          <CardDescription>Every SMS Sellora sent for you, kept for a year.</CardDescription>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">Show</span>
          <NativeSelect
            className="h-8 w-auto"
            value={status}
            onChange={(e) => setStatus(e.target.value as SmsMessageStatus | '')}
          >
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </NativeSelect>
        </label>
      </CardHeader>
      <CardContent className="grid gap-4 px-0 pb-0">
        {sm && (
          <div className="grid gap-3 px-5 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Sent in 30 days"
              value={formatNumber(sm.sent)}
              sub={`${formatNumber(sm.parts)} parts · ${formatNumber(sm.delivered)} confirmed delivered`}
            />
            <Stat
              label="Failed"
              value={formatNumber(sm.failed)}
              sub={sm.unknown ? `${formatNumber(sm.unknown)} with unknown outcome` : 'In 30 days'}
            />
            <Stat
              label="Spent on Sellora SMS"
              value={formatMoney(sm.spentMinor, 'BDT')}
              sub="From wallet cash, 30 days"
            />
            <Stat
              label="Today"
              value={`${formatNumber(sm.today)} / ${formatNumber(sm.dailyLimit)}`}
              sub="Daily limit"
            />
          </div>
        )}
        {q.isPending ? (
          <div className="px-5 pb-5">
            <Skeleton className="h-40" />
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={MessageSquareText} title="No messages yet">
            Turn on an order message or send a test.
          </EmptyState>
        ) : (
          <>
            <MessagesTable items={items} />
            <LoadMore
              hasMore={Boolean(q.hasNextPage)}
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function MessagesTable({ items, compact }: { items: SmsMessage[]; compact?: boolean }) {
  const { org } = useOrg();
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TR>
            <TH>When</TH>
            {!compact && <TH>To</TH>}
            <TH>Message</TH>
            <TH>Status</TH>
            <TH className="text-right">Cost</TH>
          </TR>
        </THead>
        <TBody>
          {items.map((m) => (
            <TR key={m.id}>
              <TD className="whitespace-nowrap text-muted-foreground">
                <time dateTime={m.createdAt} title={formatDateTime(m.createdAt)}>
                  {formatRelative(m.createdAt)}
                </time>
              </TD>
              {!compact && <TD className="tabular whitespace-nowrap">{localPhone(m.to)}</TD>}
              <TD className="min-w-64">
                <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
                  {PURPOSE_LABEL[m.purpose]}
                  {m.ref?.type === 'order' && !compact && (
                    <Link
                      href={`/app/${org.id}/orders/${m.ref.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {m.ref.label ?? 'Order'}
                    </Link>
                  )}
                  <span>
                    · {m.parts} part{m.parts === 1 ? '' : 's'}
                  </span>
                </p>
                <p className="line-clamp-2 text-sm">{m.body}</p>
                {m.status === 'failed' || m.status === 'unknown' ? (
                  <p className="text-[13px] text-destructive">
                    {m.error ?? (m.failure ? FAILURE_HELP[m.failure] : '')}
                  </p>
                ) : null}
              </TD>
              <TD>
                <StatusBadge m={m} />
              </TD>
              <TD className="tabular text-right whitespace-nowrap">
                {m.priceMinor && (m.status === 'sent' || m.status === 'delivered')
                  ? formatMoney(m.priceMinor, m.currency)
                  : m.route === 'own'
                    ? 'Your account'
                    : '—'}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

/** Numbers that asked not to get marketing messages. Order messages still reach them. */
export function OptOutsCard({ editable }: { editable: boolean }) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const q = useSmsOptOuts(org.id);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: smsKeys.optOuts(org.id) });
  const add = useMutation({
    meta: { silent: true },
    mutationFn: () => api(`/orgs/${org.id}/sms/opt-outs`, { body: { phone: phone.trim() } }),
    onSuccess: () => {
      setPhone('');
      refresh();
      toast.success('That number gets no more marketing SMS.');
    },
    onError: (err) =>
      setError(
        err instanceof ApiError
          ? (err.fieldErrors().phone ?? errorMessage(err))
          : errorMessage(err),
      ),
  });
  const remove = useMutation({
    mutationFn: (p: string) =>
      api(`/orgs/${org.id}/sms/opt-outs/${encodeURIComponent(p)}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      toast.success('Marketing SMS allowed again for that number.');
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stopped numbers</CardTitle>
        <CardDescription>
          Cart reminders and campaigns carry a link to stop them. These numbers get no marketing
          SMS; order updates still reach them.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 px-0 pb-0">
        {editable && (
          <form
            className="flex flex-wrap items-start gap-2 px-5"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              add.mutate();
            }}
          >
            <div className="grid gap-1">
              <label htmlFor="sms-stop" className="sr-only">
                Phone to stop
              </label>
              <Input
                id="sms-stop"
                inputMode="tel"
                className="w-56"
                placeholder="01712345678"
                value={phone}
                aria-invalid={Boolean(error)}
                onChange={(e) => setPhone(e.target.value)}
              />
              {error && (
                <p role="alert" className="text-[13px] text-destructive">
                  {error}
                </p>
              )}
            </div>
            <Button
              type="submit"
              variant="outline"
              loading={add.isPending}
              disabled={!phone.trim()}
            >
              <ShieldOff aria-hidden /> Stop marketing SMS
            </Button>
          </form>
        )}
        {q.isPending ? (
          <div className="px-5 pb-5">
            <Skeleton className="h-16" />
          </div>
        ) : items.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">No one has stopped messages.</p>
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Phone</TH>
                  <TH>How</TH>
                  <TH>When</TH>
                  {editable && <TH className="sr-only">Actions</TH>}
                </TR>
              </THead>
              <TBody>
                {items.map((o) => (
                  <TR key={o.phone}>
                    <TD className="tabular">{localPhone(o.phone)}</TD>
                    <TD className="text-muted-foreground">
                      {o.source === 'link' ? 'Pressed the stop link' : 'Added by staff'}
                    </TD>
                    <TD className="text-muted-foreground">{formatRelative(o.at)}</TD>
                    {editable && (
                      <TD className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Allow marketing SMS to ${localPhone(o.phone)} again`}
                          onClick={() => remove.mutate(o.phone)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
            <LoadMore
              hasMore={Boolean(q.hasNextPage)}
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            />
          </>
        )}
        {!editable && (
          <Alert tone="info">Ask someone who manages integrations to change this list.</Alert>
        )}
      </CardContent>
    </Card>
  );
}

/** The SMS this order sent, for the order page's side column. Hidden when there are none. */
export function OrderSmsCard({ orderId }: { orderId: string }) {
  const { org } = useOrg();
  const q = useSmsMessages(org.id, { orderId }, { limit: 10, refetchInterval: 20_000 });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (!items.length) return null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>SMS to the customer</CardTitle>
        <Link
          href={`/app/${org.id}/settings/sms`}
          className="text-[13px] text-primary hover:underline"
        >
          Settings
        </Link>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-3 text-sm">
          {items.map((m) => (
            <li key={m.id} className="grid gap-1">
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{PURPOSE_LABEL[m.purpose]}</span>
                <StatusBadge m={m} />
                <time
                  dateTime={m.createdAt}
                  title={formatDateTime(m.createdAt, org.timezone)}
                  className="ml-auto text-xs text-muted-foreground"
                >
                  {formatRelative(m.createdAt)}
                </time>
              </p>
              <p className="line-clamp-3 text-[13px] text-muted-foreground">{m.body}</p>
              {(m.status === 'failed' || m.status === 'unknown') && (
                <p className="text-[13px] text-destructive">
                  {m.error ?? (m.failure ? FAILURE_HELP[m.failure] : '')}
                </p>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
