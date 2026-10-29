'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { PasswordInput } from '@/components/auth/password-input';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { SmsDescriptor, SmsProviderKey } from '@/lib/api/types';

export interface GatewayInput {
  provider: SmsProviderKey;
  credentials: Record<string, string>;
  senderId: string;
}

/**
 * Connects an SMS provider account (a business's own, or Sellora's in the admin panel), or
 * changes the saved one. The API checks the credentials with the provider before saving.
 */
export function GatewayDialog({
  open,
  onOpenChange,
  providers,
  current,
  title,
  description,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: SmsDescriptor[];
  /** The saved account: the form edits it, and empty keys keep the saved ones. */
  current?: { provider: SmsProviderKey; senderId: string; credentialsHint: string | null } | null;
  title: string;
  description: string;
  /** `replace` is false when only the sender id changes on the saved account. */
  onSave: (input: GatewayInput, replace: boolean) => Promise<unknown>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        {open && (
          <GatewayForm
            providers={providers}
            current={current ?? null}
            onSave={onSave}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function GatewayForm({
  providers,
  current,
  onSave,
  onDone,
}: {
  providers: SmsDescriptor[];
  current: { provider: SmsProviderKey; senderId: string; credentialsHint: string | null } | null;
  onSave: (input: GatewayInput, replace: boolean) => Promise<unknown>;
  onDone: () => void;
}) {
  const [provider, setProvider] = useState<SmsProviderKey>(
    current?.provider ?? providers[0]?.key ?? 'bulksmsbd',
  );
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [senderId, setSenderId] = useState(current?.senderId ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const d = providers.find((p) => p.key === provider)!;
  const sameProvider = current?.provider === provider;
  const credsTyped = d.credentialFields.some((f) => (creds[f.key] ?? '').trim());
  // Keys may stay empty only when editing the saved account of the same provider.
  const missing =
    sameProvider && !credsTyped
      ? []
      : d.credentialFields.filter((f) => !(creds[f.key] ?? '').trim()).map((f) => f.key);
  const senderMissing = d.senderId === 'required' && !senderId.trim();

  const save = useMutation({
    mutationFn: () =>
      onSave(
        {
          provider,
          credentials: Object.fromEntries(
            d.credentialFields.map((f) => [f.key, (creds[f.key] ?? '').trim()]),
          ),
          senderId: senderId.trim(),
        },
        !sameProvider || credsTyped,
      ),
    onSuccess: onDone,
    onError: (err) => {
      if (err instanceof ApiError && err.errors.length) {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(err.fieldErrors()))
          flat[k.replace(/^credentials\./, '')] = v;
        setErrors(flat);
      } else setErrors({ _: errorMessage(err) });
    },
  });

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        save.mutate();
      }}
    >
      {errors._ && <Alert tone="danger">{errors._}</Alert>}
      <Field label="Provider" htmlFor="sg-provider">
        <NativeSelect
          id="sg-provider"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as SmsProviderKey);
            setCreds({});
            setErrors({});
          }}
        >
          {providers.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
              {p.reach === 'bd_mobile' ? ' · Bangladesh mobiles' : ' · any country'}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {d.credentialFields.map((f) => (
        <Field
          key={f.key}
          label={f.label}
          htmlFor={`sg-${f.key}`}
          error={errors[f.key]}
          hint={
            sameProvider && current?.credentialsHint
              ? `Saved: ${current.credentialsHint}. Leave empty to keep it.`
              : f.help
          }
        >
          {f.secret ? (
            <PasswordInput
              id={`sg-${f.key}`}
              autoComplete="off"
              value={creds[f.key] ?? ''}
              onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
            />
          ) : (
            <Input
              id={`sg-${f.key}`}
              autoComplete="off"
              value={creds[f.key] ?? ''}
              onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
            />
          )}
        </Field>
      ))}
      <Field
        label="Sender id"
        htmlFor="sg-sender"
        optional={d.senderId === 'optional'}
        error={errors.senderId}
        hint={d.senderIdHelp}
      >
        <Input
          id="sg-sender"
          value={senderId}
          maxLength={20}
          onChange={(e) => setSenderId(e.target.value)}
        />
      </Field>
      {!d.canVerify && (
        <Alert tone="info">
          {d.name} cannot check keys without sending, so send a test message after saving.
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          loading={save.isPending}
          disabled={missing.length > 0 || senderMissing}
        >
          {current && sameProvider ? 'Save' : 'Check and connect'}
        </Button>
      </DialogFooter>
    </form>
  );
}
