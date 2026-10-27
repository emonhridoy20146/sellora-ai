'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { GATEWAY_LABEL, METHOD_LABEL } from '@/components/billing/labels';
import { usePlatform } from '@/components/platform-context';
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
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/empty-state';
import { Field, Label } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { GatewayKey, GatewayStatus, ManualInstructions, ManualMethod } from '@/lib/api/types';
import { formatRelative } from '@/lib/format';

/** Credential fields each gateway's API needs. Values are write-only: the API never returns them. */
const CREDENTIAL_FIELDS: Record<
  Exclude<GatewayKey, 'manual'>,
  { key: string; label: string; hint?: string }[]
> = {
  sslcommerz: [
    { key: 'storeId', label: 'Store ID' },
    {
      key: 'storePassword',
      label: 'Store password',
      hint: 'The API password, not your SSLCommerz login.',
    },
  ],
  bkash: [
    { key: 'appKey', label: 'App key' },
    { key: 'appSecret', label: 'App secret' },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password' },
  ],
  stripe: [
    { key: 'secretKey', label: 'Secret key', hint: 'Starts with sk_test_ or sk_live_.' },
    { key: 'webhookSecret', label: 'Webhook signing secret', hint: 'Starts with whsec_.' },
  ],
};

const METHODS: ManualMethod[] = ['bkash', 'nagad', 'rocket', 'bank'];

export default function GatewaysPage() {
  const { can } = usePlatform();
  const manage = can('platform.billing.manage');
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<GatewayStatus | null>(null);
  const gateways = useQuery({
    queryKey: ['platform', 'gateways'],
    queryFn: () => api<GatewayStatus[]>('/platform/billing/gateways'),
  });
  const toggle = useMutation({
    meta: { silent: true },
    mutationFn: ({ key, ...body }: { key: GatewayKey; enabled?: boolean; sandbox?: boolean }) =>
      api(`/platform/billing/gateways/${key}`, { method: 'PUT', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform', 'gateways'] }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <PageHeader
        title="Payment gateways"
        description="How businesses pay for plans and AI credit. Secrets are stored encrypted and are never shown again."
      />
      {gateways.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : gateways.isError ? (
        <ErrorState error={gateways.error} onRetry={() => void gateways.refetch()} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {gateways.data.map((g) => {
            const busy = toggle.isPending && toggle.variables?.key === g.key;
            return (
              <Card key={g.key} className="flex flex-col">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle>{GATEWAY_LABEL[g.key] ?? g.key}</CardTitle>
                      <CardDescription>
                        {g.currencies === 'any' ? 'Any currency' : g.currencies.join(', ')}
                        {g.updatedAt ? ` · changed ${formatRelative(g.updatedAt)}` : ''}
                      </CardDescription>
                    </div>
                    <span className="flex flex-wrap justify-end gap-1">
                      {!g.configured ? (
                        <Badge tone="warning">Not set up</Badge>
                      ) : g.enabled ? (
                        <Badge tone="success">Live for businesses</Badge>
                      ) : (
                        <Badge>Off</Badge>
                      )}
                      {g.key !== 'manual' && g.configured && g.sandbox && (
                        <Badge tone="info">Test mode</Badge>
                      )}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="grid flex-1 content-start gap-3">
                  {g.key === 'manual' && g.publicConfig && (
                    <ul className="space-y-1 text-sm">
                      {g.publicConfig.accounts.map((a, i) => (
                        <li key={i} className="flex justify-between gap-3">
                          <span className="text-muted-foreground">
                            {METHOD_LABEL[a.method]} {a.label && `· ${a.label}`}
                          </span>
                          <span className="font-mono">{a.account}</span>
                        </li>
                      ))}
                      {g.publicConfig.accounts.length === 0 && (
                        <li className="text-muted-foreground">No accounts listed yet.</li>
                      )}
                    </ul>
                  )}
                  {g.webhookUrl && (
                    <div className="text-sm">
                      <p className="mb-1 text-muted-foreground">
                        {g.key === 'stripe' ? 'Webhook endpoint' : 'IPN address'} for the gateway
                        dashboard
                      </p>
                      <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5">
                        <code className="min-w-0 flex-1 truncate text-xs">{g.webhookUrl}</code>
                        <CopyButton value={g.webhookUrl} />
                      </div>
                    </div>
                  )}
                  {manage && g.configured && (
                    <div className="grid gap-2 pt-1">
                      <div className="flex items-center justify-between gap-3">
                        <label htmlFor={`gw-on-${g.key}`} className="text-sm">
                          Offer to businesses
                        </label>
                        <Switch
                          id={`gw-on-${g.key}`}
                          checked={g.enabled}
                          disabled={busy}
                          onCheckedChange={(c) => toggle.mutate({ key: g.key, enabled: c })}
                        />
                      </div>
                      {g.key !== 'manual' && (
                        <div className="flex items-center justify-between gap-3">
                          <label htmlFor={`gw-sb-${g.key}`} className="text-sm">
                            Test mode (sandbox)
                            <span className="block text-xs text-muted-foreground">
                              No real money moves.
                            </span>
                          </label>
                          <Switch
                            id={`gw-sb-${g.key}`}
                            checked={g.sandbox}
                            disabled={busy}
                            onCheckedChange={(c) => toggle.mutate({ key: g.key, sandbox: c })}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
                {manage && (
                  <CardFooter>
                    <Button variant="outline" size="sm" onClick={() => setEditing(g)}>
                      <KeyRound />
                      {g.key === 'manual'
                        ? g.configured
                          ? 'Edit instructions'
                          : 'Add instructions'
                        : g.configured
                          ? 'Replace credentials'
                          : 'Set up'}
                    </Button>
                  </CardFooter>
                )}
              </Card>
            );
          })}
        </div>
      )}
      {editing &&
        (editing.key === 'manual' ? (
          <ManualDialog gateway={editing} onClose={() => setEditing(null)} />
        ) : (
          <CredentialsDialog
            gateway={editing}
            gatewayKey={editing.key}
            onClose={() => setEditing(null)}
          />
        ))}
    </>
  );
}

function useSaveGateway(key: GatewayKey, onClose: () => void, success: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (body: { enabled?: boolean; sandbox?: boolean; credentials?: unknown }) =>
      api<GatewayStatus>(`/platform/billing/gateways/${key}`, { method: 'PUT', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['platform', 'gateways'] });
      toast.success(success);
      onClose();
    },
  });
}

function CredentialsDialog({
  gateway,
  gatewayKey,
  onClose,
}: {
  gateway: GatewayStatus;
  gatewayKey: Exclude<GatewayKey, 'manual'>;
  onClose: () => void;
}) {
  const fields = CREDENTIAL_FIELDS[gatewayKey];
  const [values, setValues] = useState<Record<string, string>>({});
  const [sandbox, setSandbox] = useState(gateway.configured ? gateway.sandbox : true);
  const [enable, setEnable] = useState(gateway.configured ? gateway.enabled : false);
  const save = useSaveGateway(gatewayKey, onClose, 'Credentials saved.');
  const errs: Record<string, string> =
    save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const complete = fields.every((f) => (values[f.key] ?? '').trim());

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`${gateway.configured ? 'Replace' : 'Set up'} ${GATEWAY_LABEL[gatewayKey] ?? gatewayKey}`}
        description="Paste the values from the gateway's merchant dashboard. They are encrypted before they are stored."
      >
        <form
          className="grid gap-4"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({
              sandbox,
              enabled: enable,
              credentials: Object.fromEntries(
                fields.map((f) => [f.key, (values[f.key] ?? '').trim()]),
              ),
            });
          }}
        >
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          {gateway.configured && (
            <Alert tone="info">
              Saved values are never shown. Enter all of them again to replace them.
            </Alert>
          )}
          {fields.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              htmlFor={`cred-${f.key}`}
              hint={f.hint}
              error={errs[`credentials.${f.key}`]}
            >
              <Input
                id={`cred-${f.key}`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                className="font-mono"
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                required
              />
            </Field>
          ))}
          <div className="grid gap-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="cred-sandbox" className="text-sm">
                These are test (sandbox) credentials
              </label>
              <Switch id="cred-sandbox" checked={sandbox} onCheckedChange={setSandbox} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="cred-enable" className="text-sm">
                Offer to businesses now
              </label>
              <Switch id="cred-enable" checked={enable} onCheckedChange={setEnable} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!complete}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface AccountRow {
  id: string;
  method: ManualMethod;
  label: string;
  account: string;
}

function ManualDialog({ gateway, onClose }: { gateway: GatewayStatus; onClose: () => void }) {
  const initial: ManualInstructions = gateway.publicConfig ?? { instructions: '', accounts: [] };
  const [instructions, setInstructions] = useState(initial.instructions);
  const [accounts, setAccounts] = useState<AccountRow[]>(() =>
    initial.accounts.map((a) => ({ ...a, id: crypto.randomUUID() })),
  );
  const [enable, setEnable] = useState(gateway.configured ? gateway.enabled : true);
  const save = useSaveGateway('manual', onClose, 'Payment instructions saved.');
  const update = (id: string, patch: Partial<AccountRow>) =>
    setAccounts((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const valid =
    accounts.every((a) => a.account.trim()) && (accounts.length > 0 || instructions.trim());

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        wide
        title="Bank and mobile transfer"
        description="Businesses see these accounts when they pay by transfer. You approve each payment in the Payments queue."
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({
              enabled: enable,
              credentials: {
                instructions: instructions.trim(),
                accounts: accounts.map(({ method, label, account }) => ({
                  method,
                  label: label.trim(),
                  account: account.trim(),
                })),
              },
            });
          }}
        >
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Accounts</legend>
            {accounts.map((a) => (
              <div key={a.id} className="grid grid-cols-[8rem_1fr_1fr_auto] items-end gap-2">
                <div>
                  <Label htmlFor={`acc-m-${a.id}`} className="sr-only">
                    Method
                  </Label>
                  <NativeSelect
                    id={`acc-m-${a.id}`}
                    value={a.method}
                    onChange={(e) => update(a.id, { method: e.target.value as ManualMethod })}
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {METHOD_LABEL[m]}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div>
                  <Label htmlFor={`acc-l-${a.id}`} className="sr-only">
                    Account name
                  </Label>
                  <Input
                    id={`acc-l-${a.id}`}
                    placeholder={
                      a.method === 'bank' ? 'Bank, branch, account name' : 'Merchant or personal'
                    }
                    maxLength={80}
                    value={a.label}
                    onChange={(e) => update(a.id, { label: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`acc-n-${a.id}`} className="sr-only">
                    Number
                  </Label>
                  <Input
                    id={`acc-n-${a.id}`}
                    className="font-mono"
                    placeholder={a.method === 'bank' ? 'Account number' : 'Wallet number'}
                    maxLength={120}
                    value={a.account}
                    onChange={(e) => update(a.id, { account: e.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove account"
                  onClick={() => setAccounts((rows) => rows.filter((r) => r.id !== a.id))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={accounts.length >= 10}
                onClick={() =>
                  setAccounts((rows) => [
                    ...rows,
                    { id: crypto.randomUUID(), method: 'bkash', label: '', account: '' },
                  ])
                }
              >
                <Plus /> Add account
              </Button>
            </div>
          </fieldset>
          <Field
            label="Instructions"
            htmlFor="man-ins"
            optional
            hint="E.g. use Send Money, and put your business name in the reference."
          >
            <Textarea
              id="man-ins"
              rows={4}
              maxLength={2000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </Field>
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <label htmlFor="man-enable" className="text-sm">
              Offer to businesses
            </label>
            <Switch id="man-enable" checked={enable} onCheckedChange={setEnable} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!valid}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
