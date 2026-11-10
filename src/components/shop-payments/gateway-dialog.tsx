'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PasswordInput } from '@/components/auth/password-input';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { ShopGatewayDescriptor, ShopPaymentAccount } from '@/lib/api/types';
import { missingKeys } from '@/lib/shop-payments';

export const shopPaymentKeys = {
  all: (orgId: string) => ['org', orgId, 'shop-payments'] as const,
};

/** Connects a gateway with the business's own keys, or replaces them. The API checks them first. */
export function GatewayDialog({
  open,
  onOpenChange,
  descriptor,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  descriptor: ShopGatewayDescriptor;
  account?: ShopPaymentAccount;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={account ? `${descriptor.name} keys` : `Connect ${descriptor.name}`}
        description={
          account
            ? 'Leave the keys empty to keep the saved ones.'
            : descriptor.checkable
              ? `${descriptor.help} Sellora checks them with ${descriptor.name} before saving.`
              : descriptor.help
        }
      >
        {/* Mounted per opening, so the form starts empty each time. */}
        {open && (
          <GatewayForm
            descriptor={descriptor}
            account={account}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function GatewayForm({
  descriptor: d,
  account,
  onDone,
}: {
  descriptor: ShopGatewayDescriptor;
  account?: ShopPaymentAccount;
  onDone: () => void;
}) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const [keys, setKeys] = useState<Record<string, string>>({});
  // New accounts start in test mode: one sandbox payment first is the safe way in.
  const [sandbox, setSandbox] = useState(account?.sandbox ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const missing = missingKeys(d.fields, keys, Boolean(account));
  const changed = d.fields.some((f) => (keys[f.key] ?? '').trim());

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const credentials = Object.fromEntries(
        d.fields.map((f) => [f.key, (keys[f.key] ?? '').trim()]),
      );
      return account
        ? api<{ account: ShopPaymentAccount }>(
            `/orgs/${org.id}/shop-payments/accounts/${account.id}`,
            {
              method: 'PATCH',
              body: {
                ...(changed ? { credentials } : {}),
                ...(sandbox !== account.sandbox ? { sandbox } : {}),
              },
            },
          )
        : api<{ account: ShopPaymentAccount }>(`/orgs/${org.id}/shop-payments/accounts`, {
            body: { gateway: d.key, credentials, sandbox },
          });
    },
    onSuccess: ({ account: a }) => {
      void qc.invalidateQueries({ queryKey: shopPaymentKeys.all(org.id) });
      toast.success(
        `${a.name} ${account ? 'saved' : 'connected'}${a.sandbox ? ' in test mode' : ''}. ${a.lastCheck.summary}`,
      );
      onDone();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.errors.length) {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(err.fieldErrors()))
          flat[k.replace(/^credentials\./, '')] = v;
        setErrors(flat);
      } else setErrors({ _: errorMessage(err) });
    },
  });

  const nothingToSave = Boolean(account) && !changed && sandbox === account?.sandbox;
  return (
    <form
      className="grid gap-4"
      noValidate
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const local: Record<string, string> = {};
        for (const k of missing) local[k] = 'Required';
        setErrors(local);
        if (Object.keys(local).length === 0) save.mutate();
      }}
    >
      {errors._ && <Alert tone="danger">{errors._}</Alert>}
      {d.fields.map((f) => {
        const id = `sp-${f.key}`;
        const common = {
          id,
          value: keys[f.key] ?? '',
          autoComplete: 'off',
          spellCheck: false,
          placeholder: account ? 'Saved; type to replace' : f.placeholder,
          'aria-invalid': Boolean(errors[f.key]) || undefined,
        };
        return (
          <Field key={f.key} label={f.label} htmlFor={id} error={errors[f.key]}>
            {f.multiline ? (
              <Textarea
                {...common}
                rows={4}
                className="font-mono text-xs"
                onChange={(e) => setKeys((k) => ({ ...k, [f.key]: e.target.value }))}
              />
            ) : f.secret ? (
              <PasswordInput
                {...common}
                onChange={(e) => setKeys((k) => ({ ...k, [f.key]: e.target.value }))}
              />
            ) : (
              <Input
                {...common}
                onChange={(e) => setKeys((k) => ({ ...k, [f.key]: e.target.value }))}
              />
            )}
          </Field>
        );
      })}
      <label className="flex items-start justify-between gap-4 text-sm">
        <span>
          <span className="font-medium">Test mode</span>
          <span className="block text-muted-foreground">
            Uses {d.name}’s sandbox with sandbox keys. Shoppers see a test badge and no real money
            moves. Turn it off with your live keys when one test payment works.
          </span>
        </span>
        <Switch checked={sandbox} onCheckedChange={setSandbox} aria-label="Test mode" />
      </label>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending} disabled={nothingToSave}>
          {d.checkable ? 'Check and save' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}
