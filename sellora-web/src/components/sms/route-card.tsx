'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleOff, Cloud, KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { SmsGatewayResult, SmsMode, SmsSettings } from '@/lib/api/types';
import { formatDateTime, formatMoney, formatRelative } from '@/lib/format';
import { senderNameProblem } from '@/lib/sms';
import { cn } from '@/lib/utils';
import { smsKeys, useSmsSettingsPatch } from './data';
import { GatewayDialog } from './gateway-dialog';

function useSetSettings() {
  const { org } = useOrg();
  const qc = useQueryClient();
  return (s: SmsSettings) => {
    qc.setQueryData(smsKeys.settings(org.id), s);
    void qc.invalidateQueries({ queryKey: smsKeys.summary(org.id) });
  };
}

/** How messages leave: off, Sellora SMS from the wallet, or the business's own provider. */
export function RouteCard({ s, editable }: { s: SmsSettings; editable: boolean }) {
  const { org } = useOrg();
  const patch = useSmsSettingsPatch(org.id);
  const setSettings = useSetSettings();
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const price = s.sellora.price;

  const choose = (mode: SmsMode) => {
    if (mode === s.mode) return;
    if (mode === 'own' && !s.own) {
      setConnecting(true);
      return;
    }
    patch.mutate(
      { mode },
      {
        onSuccess: () =>
          toast.success(
            mode === 'off'
              ? 'SMS turned off.'
              : mode === 'sellora'
                ? 'Messages now go out through Sellora SMS.'
                : `Messages now go out through ${s.own?.providerName}.`,
          ),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const check = useMutation({
    mutationFn: () =>
      api<SmsGatewayResult>(`/orgs/${org.id}/sms/gateway/check`, { method: 'POST' }),
    onSuccess: (r) => {
      setSettings(r.settings);
      toast.success(r.check?.summary ?? 'Checked.');
    },
  });

  const options: {
    mode: SmsMode;
    title: string;
    icon: typeof Cloud;
    body: React.ReactNode;
    disabled?: boolean;
  }[] = [
    {
      mode: 'off',
      title: 'Off',
      icon: CircleOff,
      body: 'No SMS are sent.',
    },
    {
      mode: 'sellora',
      title: 'Sellora SMS',
      icon: Cloud,
      disabled: !s.sellora.available,
      body: s.sellora.available ? (
        <>
          Paid from your wallet cash
          {price ? (
            <>
              : <strong>{formatMoney(price.perPartMinor, price.currency)}</strong> per SMS part
            </>
          ) : null}
          . Nothing to set up.
        </>
      ) : (
        'Not available right now.'
      ),
    },
    {
      mode: 'own',
      title: 'My SMS account',
      icon: KeyRound,
      body: s.own
        ? `${s.own.providerName} · you pay the provider directly.`
        : 'BulkSMSBD, Alpha SMS, SSL Wireless or Twilio. You pay the provider directly.',
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>How SMS go out</CardTitle>
        <CardDescription>
          Order updates go to customers by SMS. Choose who sends them.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div role="radiogroup" aria-label="How SMS go out" className="grid gap-3 sm:grid-cols-3">
          {options.map((o) => {
            const Icon = o.icon;
            const active = s.mode === o.mode;
            return (
              <button
                key={o.mode}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!editable || o.disabled || patch.isPending}
                onClick={() => choose(o.mode)}
                className={cn(
                  'flex flex-col items-start gap-1.5 rounded-lg border p-3.5 text-left text-sm transition-colors',
                  active
                    ? 'border-primary bg-info-soft ring-1 ring-primary'
                    : 'hover:bg-accent disabled:opacity-60',
                )}
              >
                <span className="flex items-center gap-2 font-medium">
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                  {o.title}
                  {active && <Badge tone="info">In use</Badge>}
                </span>
                <span className="text-[13px] text-muted-foreground">{o.body}</span>
              </button>
            );
          })}
        </div>

        {s.mode !== 'off' &&
          (s.route.ready ? (
            <Alert tone="success">
              Messages go out through <strong>{s.route.providerName}</strong>
              {s.route.senderId ? (
                <>
                  {' '}
                  from <strong>{s.route.senderId}</strong>
                </>
              ) : null}
              .
              {s.route.pricePerPartMinor > 0 &&
                ` Each SMS part costs ${formatMoney(s.route.pricePerPartMinor, s.route.currency)} from your wallet cash; free credit is for AI only.`}{' '}
              Up to {s.dailyLimit.toLocaleString()} messages a day.
            </Alert>
          ) : (
            <Alert tone="warning">{s.route.message}</Alert>
          ))}

        {s.own && (
          <div className="grid gap-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1 text-sm">
                <p className="font-medium">
                  {s.own.providerName}{' '}
                  {s.mode === 'own' ? (
                    <Badge tone="success">Sending</Badge>
                  ) : (
                    <Badge tone="neutral">Saved, not in use</Badge>
                  )}
                </p>
                <p className="text-muted-foreground">
                  {s.own.credentialsHint}
                  {s.own.senderId ? ` · sender ${s.own.senderId}` : ''}
                  {s.own.reach === 'bd_mobile' ? ' · Bangladeshi mobiles' : ' · any country'}
                </p>
                {s.own.lastCheck && (
                  <p className="text-[13px] text-muted-foreground">
                    {s.own.lastCheck.summary} Checked{' '}
                    <time dateTime={s.own.lastCheck.at} title={formatDateTime(s.own.lastCheck.at)}>
                      {formatRelative(s.own.lastCheck.at)}
                    </time>
                    .
                  </p>
                )}
              </div>
              {editable && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    loading={check.isPending}
                    onClick={() => check.mutate()}
                  >
                    <RefreshCw aria-hidden /> Check
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConnecting(true)}>
                    Change
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${s.own.providerName}`}
                    onClick={() => setRemoving(true)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              )}
            </div>
            {s.own.lastError && (
              <Alert tone="danger" title="The last message did not go out">
                {s.own.lastError.message} ({formatRelative(s.own.lastError.at)})
              </Alert>
            )}
          </div>
        )}
      </CardContent>

      <GatewayDialog
        open={connecting}
        onOpenChange={setConnecting}
        providers={s.providers}
        current={s.own}
        title={s.own ? 'Your SMS account' : 'Connect your SMS account'}
        description="Paste the API details from your SMS provider’s panel. Sellora checks them with the provider before saving and never shows them again."
        onSave={async (input, replace) => {
          const r = await api<SmsGatewayResult>(`/orgs/${org.id}/sms/gateway`, {
            method: replace ? 'PUT' : 'PATCH',
            body: replace ? input : { senderId: input.senderId },
          });
          let settings = r.settings;
          // Connecting from the "My SMS account" choice also starts using it.
          if (settings.mode !== 'own' && !s.own)
            settings = await api<SmsSettings>(`/orgs/${org.id}/sms`, {
              method: 'PATCH',
              body: { mode: 'own' },
            });
          setSettings(settings);
          toast.success(r.check?.summary ?? 'Saved.');
        }}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${s.own?.providerName ?? 'your SMS account'}?`}
        description={
          s.mode === 'own'
            ? 'SMS turn off until you connect an account again or choose Sellora SMS.'
            : 'The saved API details are deleted.'
        }
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          setSettings(await api<SmsSettings>(`/orgs/${org.id}/sms/gateway`, { method: 'DELETE' }));
          toast.success('SMS account removed.');
        }}
      />
    </Card>
  );
}

/** A sender name (masking) for Sellora SMS, approved by Sellora before use. */
export function SenderNameCard({ s, editable }: { s: SmsSettings; editable: boolean }) {
  const { org } = useOrg();
  const setSettings = useSetSettings();
  const patch = useSmsSettingsPatch(org.id);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const request = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<SmsSettings>(`/orgs/${org.id}/sms/sender-name`, {
        method: 'PUT',
        body: { name: name.trim() },
      }),
    onSuccess: (r) => {
      setSettings(r);
      setName('');
      toast.success('Sent to Sellora for approval. You will get an email.');
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? (err.fieldErrors().name ?? errorMessage(err)) : errorMessage(err),
      ),
  });
  const cancel = useMutation({
    mutationFn: () => api<SmsSettings>(`/orgs/${org.id}/sms/sender-name`, { method: 'DELETE' }),
    onSuccess: setSettings,
  });
  const n = s.senderName;
  const price = s.sellora.price;
  const problem = name ? senderNameProblem(name) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sender name</CardTitle>
        <CardDescription>
          Customers see your shop’s name instead of a number
          {price
            ? `. It costs ${formatMoney(price.senderNamePerPartMinor, price.currency)} per part instead of ${formatMoney(price.perPartMinor, price.currency)}`
            : ''}
          . Operators need Sellora to approve it first.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {n && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3.5">
            <div className="space-y-1 text-sm">
              <p className="flex items-center gap-2 font-medium">
                {n.name}
                {n.status === 'approved' ? (
                  <Badge tone="success">Approved</Badge>
                ) : n.status === 'pending' ? (
                  <Badge tone="warning">Waiting for approval</Badge>
                ) : (
                  <Badge tone="danger">Not approved</Badge>
                )}
              </p>
              <p className="text-[13px] text-muted-foreground">
                Asked {formatRelative(n.requestedAt)}
                {n.decidedAt ? ` · decided ${formatRelative(n.decidedAt)}` : ''}
              </p>
              {n.reason && <p className="text-[13px] text-destructive">{n.reason}</p>}
            </div>
            <div className="flex items-center gap-3">
              {n.status === 'approved' && (
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={s.useSenderName}
                    disabled={!editable || patch.isPending}
                    onCheckedChange={(v) =>
                      patch.mutate(
                        { useSenderName: v },
                        { onError: (err) => toast.error(errorMessage(err)) },
                      )
                    }
                  />
                  Send from {n.name}
                </label>
              )}
              {editable && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  {n.status === 'pending' ? 'Withdraw' : 'Remove'}
                </Button>
              )}
            </div>
          </div>
        )}
        {editable && n?.status !== 'pending' && (
          <form
            className="grid gap-3 sm:max-w-md"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              request.mutate();
            }}
          >
            <Field
              label={n ? 'Ask for another name' : 'Name to ask for'}
              htmlFor="sms-sender-name"
              error={error ?? problem ?? undefined}
              hint="3 to 11 English letters and digits, no spaces. Use your shop or brand name."
            >
              <Input
                id="sms-sender-name"
                value={name}
                maxLength={11}
                placeholder="NakshiGhor"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div>
              <Button
                type="submit"
                loading={request.isPending}
                disabled={!name || Boolean(problem)}
              >
                Send for approval
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
