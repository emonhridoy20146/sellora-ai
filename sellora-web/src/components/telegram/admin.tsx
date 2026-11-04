'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, PlugZap, Send, Trash2, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  TelegramAlertSettings,
  TelegramChat,
  TelegramLinkCode,
  TelegramMessage,
  TelegramOverview,
  TelegramReportSettings,
  TelegramTopic,
} from '@/lib/api/types';
import { hourLabel } from '@/lib/backups';
import { formatDateTime, formatRelative } from '@/lib/format';
import {
  CHAT_KIND,
  MESSAGE_KIND,
  MESSAGE_STATUS,
  linkCommand,
  sameTopics,
  telegramText,
  wholeNumber,
} from '@/lib/telegram';

export const telegramKeys = {
  all: ['platform', 'telegram'] as const,
  overview: () => [...telegramKeys.all, 'overview'] as const,
  messages: () => [...telegramKeys.all, 'messages'] as const,
};

export function useTelegram(linking = false) {
  return useQuery({
    queryKey: telegramKeys.overview(),
    queryFn: () => api<TelegramOverview>('/platform/telegram'),
    // While a link code is out, look for the new chat every few seconds.
    refetchInterval: linking ? 3000 : 60_000,
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: telegramKeys.all });
  };
}

// ---------------------------------------------------------------- the bot

export function BotCard({ overview }: { overview: TelegramOverview }) {
  const refresh = useRefresh();
  const [disconnecting, setDisconnecting] = useState(false);
  const connect = useMutation({
    mutationFn: () => api<{ url: string }>('/platform/telegram/webhook', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Telegram now sends commands and link codes to this server.');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const webhookOk = overview.webhook?.url === overview.webhookUrl;
  return (
    <Card data-testid="telegram-bot">
      <CardHeader>
        <CardTitle>The bot</CardTitle>
        <CardDescription>
          One Telegram bot sends reports and alerts to the chats below. Its token is a server
          setting (TELEGRAM_BOT_TOKEN, from @BotFather) and is never shown here.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {!overview.configured ? (
          <Alert tone="warning" title="Telegram is not set up on this server">
            Set TELEGRAM_BOT_TOKEN on the API and the worker, then restart them. Until then, alerts
            go to the platform owners by email
            {overview.alerts.emailFallback ? '' : ' (turned off below)'} and no reports are sent.
          </Alert>
        ) : overview.problem ? (
          <Alert tone="danger" title="Telegram did not accept the bot token">
            {overview.problem}
          </Alert>
        ) : (
          <p data-testid="telegram-bot-name">
            Bot: <span className="font-medium">@{overview.bot?.username}</span>{' '}
            <span className="text-muted-foreground">({overview.bot?.name})</span>
          </p>
        )}
        {overview.configured && !overview.problem && (
          <div className="grid gap-2">
            <p>
              Webhook:{' '}
              {webhookOk ? (
                <Badge tone="success" data-testid="telegram-webhook-on">
                  Connected
                </Badge>
              ) : overview.webhook ? (
                <Badge tone="warning">Points elsewhere</Badge>
              ) : (
                <Badge tone="neutral" data-testid="telegram-webhook-off">
                  Not connected
                </Badge>
              )}{' '}
              <span className="font-mono text-xs break-all text-muted-foreground">
                {overview.webhookUrl}
              </span>
            </p>
            {overview.webhook?.lastError && (
              <p className="text-[13px] text-destructive">
                Telegram&apos;s last delivery error: {overview.webhook.lastError}
              </p>
            )}
            <p className="text-[13px] text-muted-foreground">
              The webhook lets people in the chats link them and use /status, /today, /backup and
              /servers. Reports and alerts are sent without it. Real Telegram needs a public HTTPS
              address.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={webhookOk ? 'outline' : 'default'}
                loading={connect.isPending}
                onClick={() => connect.mutate()}
              >
                <PlugZap /> {webhookOk ? 'Connect again' : 'Connect'}
              </Button>
              {overview.webhook && (
                <Button variant="outline" onClick={() => setDisconnecting(true)}>
                  <Unplug /> Disconnect
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title="Disconnect the webhook?"
        description="The bot keeps sending reports and alerts, but stops answering commands and cannot link new chats until you connect again."
        confirmLabel="Disconnect"
        destructive
        onConfirm={async () => {
          await api('/platform/telegram/webhook', { method: 'DELETE' });
          toast.success('Webhook disconnected.');
          refresh();
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- chats

function LinkPanel({ code, onDone }: { code: TelegramLinkCode; onDone: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const expired = new Date(code.expiresAt).getTime() <= now;
  return (
    <div
      className="grid gap-3 rounded-lg border bg-muted/40 p-4 text-sm"
      data-testid="telegram-link"
    >
      <p className="font-medium">
        {expired
          ? 'This code has expired.'
          : `Link code, works once until ${formatDateTime(code.expiresAt)}:`}{' '}
        <span className="font-mono" data-testid="telegram-link-code">
          {code.code}
        </span>
      </p>
      {!expired && (
        <ol className="grid list-decimal gap-2 pl-5">
          <li>
            For your own chat with the bot:{' '}
            {code.startUrl ? (
              <a
                className="font-medium text-primary underline-offset-2 hover:underline"
                href={code.startUrl}
                target="_blank"
                rel="noreferrer"
              >
                open @{code.botUsername} and press Start
              </a>
            ) : (
              <>send the bot /start {code.code}</>
            )}
            .
          </li>
          <li>
            For a group: add @{code.botUsername ?? 'the bot'} to the group, then send{' '}
            <span className="font-mono">{linkCommand(code.code)}</span> in it.{' '}
            <CopyButton
              value={linkCommand(code.code)}
              label="Copy"
              ariaLabel="Copy the group command"
            />
          </li>
        </ol>
      )}
      <p className="text-[13px] text-muted-foreground">
        The chat appears below once the bot gets the code; it starts with every topic your role may
        give. This needs the webhook to be connected.
      </p>
      <div>
        <Button variant="outline" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function ChatRow({ chat, topics }: { chat: TelegramChat; topics: TelegramOverview['topics'] }) {
  const refresh = useRefresh();
  const [chosen, setChosen] = useState<TelegramTopic[]>(chat.topics);
  const [removing, setRemoving] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api(`/platform/telegram/chats/${encodeURIComponent(chat.chatId)}`, {
        method: 'PATCH',
        body: { topics: chosen },
      }),
    onSuccess: () => {
      toast.success(`Saved what ${chat.title} gets.`);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const test = useMutation({
    mutationFn: () =>
      api(`/platform/telegram/chats/${encodeURIComponent(chat.chatId)}/test`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(`Test message on its way to ${chat.title}.`);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const id = `chat-${chat.chatId.replace(/[^\d]/g, '')}`;
  return (
    <div className="grid gap-3 rounded-lg border p-4" data-testid={`telegram-chat-${chat.chatId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{chat.title}</span>
        <Badge tone="outline">{CHAT_KIND[chat.kind]}</Badge>
        {chat.status === 'active' ? (
          <Badge tone="success">Active</Badge>
        ) : (
          <Badge tone="danger" data-testid="telegram-chat-unreachable">
            Unreachable
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          Linked by {chat.addedBy.label ?? 'an admin'} {formatRelative(chat.addedAt)} · id{' '}
          <span className="font-mono">{chat.chatId}</span>
        </span>
      </div>
      {chat.status === 'unreachable' && (
        <p className="text-[13px] text-destructive">
          The bot cannot write here ({chat.lastError ?? 'Telegram refused'}). Unblock the bot or add
          it back to the group, then send a test.
        </p>
      )}
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Gets</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {topics.map((t) => (
            <label
              key={t.topic}
              className="flex items-center gap-2 text-sm"
              htmlFor={`${id}-${t.topic}`}
            >
              <Checkbox
                id={`${id}-${t.topic}`}
                checked={chosen.includes(t.topic)}
                disabled={!t.allowed}
                onCheckedChange={(on) =>
                  setChosen(on ? [...chosen, t.topic] : chosen.filter((x) => x !== t.topic))
                }
              />
              {t.label}
              {chat.blockedTopics.includes(t.topic) && (
                <Badge tone="warning">Held: the admin who linked it lost access</Badge>
              )}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={sameTopics(chosen, chat.topics)}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
        <Button size="sm" variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
          <Send /> Send a test
        </Button>
        <Button size="sm" variant="outline" onClick={() => setRemoving(true)}>
          <Trash2 /> Remove
        </Button>
      </div>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${chat.title}?`}
        description="It gets no more reports or alerts, and the bot stops answering commands there."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          await api(`/platform/telegram/chats/${encodeURIComponent(chat.chatId)}`, {
            method: 'DELETE',
          });
          toast.success(`${chat.title} removed.`);
          refresh();
        }}
      />
    </div>
  );
}

export function ChatsCard({
  overview,
  onLinking,
}: {
  overview: TelegramOverview;
  onLinking: (on: boolean) => void;
}) {
  const refresh = useRefresh();
  const [code, setCode] = useState<TelegramLinkCode | null>(null);
  const [chatId, setChatId] = useState('');
  const [error, setError] = useState<string | undefined>();
  // How many chats there were when the code was made: one more means it worked.
  const [baseline, setBaseline] = useState(0);
  const link = useMutation({
    mutationFn: () => api<TelegramLinkCode>('/platform/telegram/link-code', { method: 'POST' }),
    onSuccess: (c) => {
      setBaseline(overview.chats.length);
      setCode(c);
      onLinking(true);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const add = useMutation({
    mutationFn: () =>
      api<{ chats: TelegramChat[] }>('/platform/telegram/chats', {
        method: 'POST',
        body: { chatId: chatId.trim() },
      }),
    onSuccess: () => {
      setChatId('');
      setError(undefined);
      toast.success('Chat added. The bot said hello there.');
      refresh();
    },
    onError: (err) => {
      setError(
        err instanceof ApiError
          ? (err.fieldErrors().chatId ?? errorMessage(err))
          : errorMessage(err),
      );
    },
  });
  const done = () => {
    setCode(null);
    onLinking(false);
  };
  const linked = code !== null && overview.chats.length > baseline;

  return (
    <Card data-testid="telegram-chats">
      <CardHeader>
        <CardTitle>Chats</CardTitle>
        <CardDescription>
          Only these chats get messages, and only the topics ticked for each. A chat can get only
          what the admin who linked it may see (for example payment alerts need billing access).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {overview.chats.length === 0 ? (
          <EmptyState title="No chats yet">
            Link your own chat with the bot, or a group of the people who run Sellora.
          </EmptyState>
        ) : (
          // Keyed by the saved topics too, so the ticks start again from what was saved.
          overview.chats.map((c) => (
            <ChatRow key={`${c.chatId}:${c.topics.join()}`} chat={c} topics={overview.topics} />
          ))
        )}
        {linked ? (
          <Alert
            tone="success"
            title="Chat linked"
            action={
              <Button variant="outline" size="sm" onClick={done}>
                Done
              </Button>
            }
          >
            Choose what it gets above. The bot said hello there.
          </Alert>
        ) : code ? (
          <LinkPanel code={code} onDone={done} />
        ) : (
          overview.configured && (
            <div className="flex flex-wrap items-end gap-3">
              <Button loading={link.isPending} onClick={() => link.mutate()}>
                <Link2 /> Link a chat
              </Button>
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (chatId.trim()) add.mutate();
                }}
              >
                <Field label="Or add by chat id" htmlFor="telegram-chat-id" error={error}>
                  <Input
                    id="telegram-chat-id"
                    inputMode="numeric"
                    placeholder="-1001234567890"
                    value={chatId}
                    onChange={(e) => setChatId(e.target.value)}
                    aria-invalid={Boolean(error)}
                  />
                </Field>
                <Button type="submit" variant="outline" loading={add.isPending}>
                  Add
                </Button>
              </form>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- reports

const REPORTS: { kind: 'daily' | 'weekly' | 'monthly'; label: string; when: string }[] = [
  { kind: 'daily', label: 'Daily report', when: 'every day, covering the 24 hours before' },
  { kind: 'weekly', label: 'Weekly report', when: 'on Mondays, covering the 7 days before' },
  { kind: 'monthly', label: 'Monthly report', when: 'on the 1st, covering the month before' },
];

export function ReportsCard({ overview }: { overview: TelegramOverview }) {
  const qc = useQueryClient();
  const [r, setR] = useState<TelegramReportSettings>(overview.reports);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      api<{ reports: TelegramReportSettings }>('/platform/telegram/settings', {
        method: 'PATCH',
        body: { reports: { ...r, timezone: r.timezone.trim() } },
      }),
    onSuccess: () => {
      setErrors({});
      toast.success('Report settings saved.');
      void qc.invalidateQueries({ queryKey: telegramKeys.all });
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      toast.error(errorMessage(err));
    },
  });
  const sendNow = useMutation({
    mutationFn: (kind: string) =>
      api<{ chats: number }>('/platform/telegram/reports', { method: 'POST', body: { kind } }),
    onSuccess: (res) => {
      toast.success(
        res.chats
          ? `Report on its way to ${res.chats} chat${res.chats === 1 ? '' : 's'}.`
          : 'No chat gets reports: tick "Daily, weekly and monthly reports" on a chat first.',
      );
      void qc.invalidateQueries({ queryKey: telegramKeys.messages() });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card data-testid="telegram-reports">
      <CardHeader>
        <CardTitle>Reports</CardTitle>
        <CardDescription>
          Sign-ups, businesses, revenue and MRR, AI replies, real AI cost and profit, orders, SMS,
          backups, queues and the worker&apos;s host. Counts only: never customers&apos; names,
          phone numbers or messages.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-3">
            {REPORTS.map((x) => (
              <div key={x.kind} className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-3 text-sm">
                  <Switch
                    checked={r[x.kind]}
                    onCheckedChange={(on) => setR({ ...r, [x.kind]: on })}
                    aria-label={x.label}
                  />
                  <span>
                    <span className="font-medium">{x.label}</span>{' '}
                    <span className="text-muted-foreground">{x.when}</span>
                    <span className="block text-xs text-muted-foreground">
                      Last scheduled:{' '}
                      {overview.lastSent[x.kind]
                        ? formatDateTime(overview.lastSent[x.kind], r.timezone)
                        : 'not yet'}
                    </span>
                  </span>
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!overview.configured}
                  loading={sendNow.isPending && sendNow.variables === x.kind}
                  onClick={() => sendNow.mutate(x.kind)}
                  title={`The ${x.kind === 'daily' ? '24 hours' : x.kind === 'weekly' ? '7 days' : '30 days'} up to now`}
                >
                  Send now
                </Button>
              </div>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Time" htmlFor="report-hour">
              <NativeSelect
                id="report-hour"
                value={r.hour}
                onChange={(e) => setR({ ...r, hour: Number(e.target.value) })}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              label="Time zone"
              htmlFor="report-timezone"
              error={errors['reports.timezone']}
              hint="For example Asia/Dhaka."
            >
              <Input
                id="report-timezone"
                value={r.timezone}
                onChange={(e) => setR({ ...r, timezone: e.target.value })}
                aria-invalid={Boolean(errors['reports.timezone'])}
              />
            </Field>
          </div>
          <div>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- alerts

const THRESHOLDS: {
  key: keyof Pick<TelegramAlertSettings, 'queueBacklog' | 'loginFailures' | 'aiErrors'>;
  label: string;
  hint: string;
  max: number;
}[] = [
  {
    key: 'loginFailures',
    label: 'Failed sign-ins',
    hint: 'Across the platform in 15 minutes. 0 turns it off.',
    max: 100_000,
  },
  {
    key: 'aiErrors',
    label: 'AI provider errors',
    hint: 'In 15 minutes. A refused key alerts at once.',
    max: 100_000,
  },
  {
    key: 'queueBacklog',
    label: 'Queue backlog',
    hint: 'Jobs waiting in one queue.',
    max: 1_000_000,
  },
];

export function AlertsCard({ overview }: { overview: TelegramOverview }) {
  const qc = useQueryClient();
  const [a, setA] = useState<TelegramAlertSettings>(overview.alerts);
  const [factor, setFactor] = useState(String(overview.alerts.aiSpendFactor));
  const save = useMutation({
    mutationFn: () =>
      api<{ alerts: TelegramAlertSettings }>('/platform/telegram/settings', {
        method: 'PATCH',
        body: { alerts: { ...a, aiSpendFactor: Math.min(100, Math.max(0, Number(factor) || 0)) } },
      }),
    onSuccess: () => {
      toast.success('Alert settings saved.');
      void qc.invalidateQueries({ queryKey: telegramKeys.all });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card data-testid="telegram-alerts">
      <CardHeader>
        <CardTitle>Alerts</CardTitle>
        <CardDescription>
          Sent at once: failed or unverified platform backups, a failed off-site copy or test
          restore, no verified backup for 26 hours, failed payments, AI provider trouble and spend
          spikes, sign-in failure spikes and queue backlogs. Repeats within 30 minutes are grouped.
          Server-down, disk and certificate alerts come from the monitoring system instead.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={a.enabled}
              onCheckedChange={(enabled) => setA({ ...a, enabled })}
              aria-label="Send alerts"
            />
            Send alerts
          </label>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {THRESHOLDS.map((t) => (
              <Field key={t.key} label={t.label} htmlFor={`alert-${t.key}`} hint={t.hint}>
                <Input
                  id={`alert-${t.key}`}
                  inputMode="numeric"
                  value={a[t.key]}
                  onChange={(e) => setA({ ...a, [t.key]: wholeNumber(e.target.value, 0, t.max) })}
                />
              </Field>
            ))}
            <Field
              label="AI spend spike"
              htmlFor="alert-aiSpendFactor"
              hint="Today over this many times the 7-day daily average."
            >
              <Input
                id="alert-aiSpendFactor"
                inputMode="decimal"
                value={factor}
                onChange={(e) => setFactor(e.target.value.replace(/[^\d.]/g, ''))}
              />
            </Field>
          </div>
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={a.emailFallback}
              onCheckedChange={(emailFallback) => setA({ ...a, emailFallback })}
              aria-label="Email the owners when Telegram cannot take an alert"
            />
            Email the platform owners when Telegram is not set up, no chat takes an alert, or
            Telegram does not take it
          </label>
          <div>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- what was sent

export function MessagesCard({ chats }: { chats: TelegramChat[] }) {
  const q = useQuery({
    queryKey: telegramKeys.messages(),
    queryFn: () => api<TelegramMessage[]>('/platform/telegram/messages', { query: { limit: 50 } }),
    refetchInterval: (s) =>
      (s.state.data ?? []).some((m) => m.status === 'queued') ? 3000 : 30_000,
  });
  const names = new Map(chats.map((c) => [c.chatId, c.title]));
  return (
    <Card data-testid="telegram-messages">
      <CardHeader>
        <CardTitle>Sent lately</CardTitle>
        <CardDescription>The bot&apos;s last 50 messages. Kept for 90 days.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <EmptyState title="Nothing sent yet">Send a test to a chat to see it here.</EmptyState>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Chat</TH>
                <TH>What</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.map((m) => {
                const text = telegramText(m.text);
                return (
                  <TR key={m.id} data-testid={`telegram-message-${m.id}`}>
                    <TD className="whitespace-nowrap">{formatDateTime(m.createdAt)}</TD>
                    <TD>{names.get(m.chatId) ?? m.chatId}</TD>
                    <TD className="max-w-md">
                      <span className="text-xs text-muted-foreground">{MESSAGE_KIND[m.kind]}</span>
                      <p className="line-clamp-2 text-sm" title={text}>
                        {text}
                      </p>
                    </TD>
                    <TD>
                      <Badge tone={MESSAGE_STATUS[m.status].tone}>
                        {MESSAGE_STATUS[m.status].label}
                      </Badge>
                      {m.error && (
                        <p className="mt-1 max-w-56 text-xs text-destructive">
                          {m.error}
                          {m.attempts > 1 ? ` (${m.attempts} tries)` : ''}
                        </p>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
