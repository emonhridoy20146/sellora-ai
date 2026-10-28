'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PasswordInput } from '@/components/auth/password-input';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  CourierAccount,
  CourierAccountResult,
  CourierDescriptor,
  CourierStore,
} from '@/lib/api/types';
import { kgInput, missingCredentials, parseKg, weightProblem } from '@/lib/couriers';
import { courierKeys } from './data';

/** Adds a courier account, or edits one. The API checks the credentials with the courier. */
export function AccountDialog({
  open,
  onOpenChange,
  descriptor,
  account,
  firstAccount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  descriptor: CourierDescriptor;
  account?: CourierAccount;
  /** No account yet: this one becomes the default on its own. */
  firstAccount?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={account ? `${account.name} settings` : `Connect ${descriptor.name}`}
        description={
          account
            ? 'Leave the keys empty to keep the saved ones.'
            : `Paste the API details from your ${descriptor.name} merchant panel. Sellora checks them with ${descriptor.name} before saving.`
        }
      >
        {/* Mounted per opening, so the form starts from the saved settings each time. */}
        {open && (
          <AccountForm
            descriptor={descriptor}
            account={account}
            firstAccount={firstAccount}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AccountForm({
  descriptor: d,
  account,
  firstAccount,
  onDone,
}: {
  descriptor: CourierDescriptor;
  account?: CourierAccount;
  firstAccount?: boolean;
  onDone: () => void;
}) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const [name, setName] = useState(account?.name ?? d.name);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [sandbox, setSandbox] = useState(account?.sandbox ?? false);
  const [deliveryType, setDeliveryType] = useState(
    account?.settings.deliveryType ?? d.deliveryTypes[0]?.value ?? '',
  );
  const [weight, setWeight] = useState(
    kgInput(account?.defaultWeightGrams ?? Math.max(500, d.weightGrams.min)),
  );
  const [isDefault, setIsDefault] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // After saving: the courier has several pickup stores and none is chosen yet.
  const [stores, setStores] = useState<{ account: CourierAccount; list: CourierStore[] } | null>(
    null,
  );
  const [storeId, setStoreId] = useState('');

  const grams = parseKg(weight);
  const weightError = weightProblem(grams, d.weightGrams);
  const missing = missingCredentials(d.credentialFields, creds, Boolean(account));
  const credsChanged = d.credentialFields.some((f) => (creds[f.key] ?? '').trim());

  const done = (result: CourierAccountResult, verb: string) => {
    void qc.invalidateQueries({ queryKey: courierKeys.all(org.id) });
    const a = result.account;
    const list = result.check?.stores ?? [];
    if (d.pickupStore !== 'none' && !a.settings.storeId && list.length > 1) {
      setStores({ account: a, list });
      setStoreId(list[0]!.id);
      return;
    }
    toast.success(`${a.name} ${verb}.${result.check ? ` ${result.check.summary}` : ''}`);
    onDone();
  };

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const credentials = Object.fromEntries(
        d.credentialFields.map((f) => [f.key, (creds[f.key] ?? '').trim()]),
      );
      const settings = d.deliveryTypes.length ? { deliveryType } : undefined;
      return account
        ? api<CourierAccountResult>(`/orgs/${org.id}/couriers/accounts/${account.id}`, {
            method: 'PATCH',
            body: {
              name: name.trim(),
              ...(credsChanged ? { credentials } : {}),
              ...(d.sandbox && sandbox !== account.sandbox ? { sandbox } : {}),
              ...(settings ? { settings } : {}),
              defaultWeightGrams: grams,
            },
          })
        : api<CourierAccountResult>(`/orgs/${org.id}/couriers/accounts`, {
            body: {
              provider: d.key,
              name: name.trim(),
              credentials,
              ...(d.sandbox ? { sandbox } : {}),
              ...(settings ? { settings } : {}),
              defaultWeightGrams: grams,
              ...(isDefault ? { isDefault } : {}),
            },
          });
    },
    onSuccess: (r) => done(r, account ? 'saved' : 'connected'),
    onError: (err) => {
      if (err instanceof ApiError && err.errors.length) {
        const fe = err.fieldErrors();
        // credentials.apiKey → apiKey
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(fe))
          flat[k.replace(/^(credentials|settings)\./, '')] = v;
        setErrors(flat);
      } else setErrors({ _: errorMessage(err) });
    },
  });

  const pickStore = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<CourierAccountResult>(`/orgs/${org.id}/couriers/accounts/${stores!.account.id}`, {
        method: 'PATCH',
        body: { settings: { storeId } },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: courierKeys.all(org.id) });
      toast.success(`${r.account.name} is ready to book parcels.`);
      onDone();
    },
    onError: (err) => setErrors({ _: errorMessage(err) }),
  });

  if (stores)
    return (
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          pickStore.mutate();
        }}
      >
        <Alert tone="success">
          {stores.account.name} is connected. Choose where {d.name} picks parcels up.
        </Alert>
        {errors._ && <Alert tone="danger">{errors._}</Alert>}
        <Field label="Pickup store" htmlFor="ca-store">
          <NativeSelect id="ca-store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {stores.list.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.address ? ` · ${s.address}` : ''}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            Later
          </Button>
          <Button type="submit" loading={pickStore.isPending}>
            Use this store
          </Button>
        </DialogFooter>
      </form>
    );

  return (
    <form
      className="grid gap-4"
      noValidate
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const local: Record<string, string> = {};
        if (!name.trim()) local.name = 'Give the account a name';
        for (const k of missing) local[k] = 'Required';
        if (weightError) local.weight = weightError;
        setErrors(local);
        if (Object.keys(local).length === 0) save.mutate();
      }}
    >
      {errors._ && <Alert tone="danger">{errors._}</Alert>}
      <Field
        label="Name"
        htmlFor="ca-name"
        error={errors.name}
        hint="Only your team sees it, such as “Steadfast main”."
      >
        <Input id="ca-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </Field>
      {d.credentialFields.map((f) => {
        const id = `ca-${f.key}`;
        const props = {
          id,
          value: creds[f.key] ?? '',
          autoComplete: 'off',
          spellCheck: false,
          placeholder: account ? 'Saved; type to replace' : undefined,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
            setCreds((c) => ({ ...c, [f.key]: e.target.value })),
          'aria-invalid': Boolean(errors[f.key]) || undefined,
        };
        return (
          <Field key={f.key} label={f.label} htmlFor={id} error={errors[f.key]} hint={f.help}>
            {f.secret ? <PasswordInput {...props} /> : <Input {...props} />}
          </Field>
        );
      })}
      <div className="grid gap-4 sm:grid-cols-2">
        {d.deliveryTypes.length > 0 && (
          <Field label="Delivery type" htmlFor="ca-type" error={errors.deliveryType}>
            <NativeSelect
              id="ca-type"
              value={deliveryType}
              onChange={(e) => setDeliveryType(e.target.value)}
            >
              {d.deliveryTypes.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field
          label="Usual parcel weight (kg)"
          htmlFor="ca-weight"
          error={errors.weight ?? errors.defaultWeightGrams}
          hint="Used when an order does not say."
        >
          <Input
            id="ca-weight"
            inputMode="decimal"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
          />
        </Field>
      </div>
      {d.sandbox && (
        <label className="flex items-start justify-between gap-4 text-sm">
          <span>
            <span className="font-medium">Test mode</span>
            <span className="block text-muted-foreground">
              Uses {d.name}’s sandbox with sandbox keys. Nothing is picked up.
            </span>
          </span>
          <Switch checked={sandbox} onCheckedChange={setSandbox} aria-label="Test mode" />
        </label>
      )}
      {!account && !firstAccount && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(v === true)} />
          Use it by default when sending parcels
        </label>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          {account ? 'Save' : `Check and connect`}
        </Button>
      </DialogFooter>
    </form>
  );
}
