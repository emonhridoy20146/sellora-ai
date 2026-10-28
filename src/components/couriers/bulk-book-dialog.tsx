'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { commerceKeys } from '@/components/commerce/hooks';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { BulkBookResult } from '@/lib/api/types';
import { formatWeight, parseKg, weightProblem } from '@/lib/couriers';
import { useCourierChoices } from './data';

/** Sends the selected orders to one courier; the bookings run in the background. */
export function BulkBookDialog({
  orderIds,
  open,
  onOpenChange,
  onQueued,
}: {
  orderIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onQueued: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Send ${orderIds.length} ${orderIds.length === 1 ? 'order' : 'orders'} to a courier`}
        description="Confirmed and packed orders are booked one by one in the background. Cash to collect is what each customer still owes."
      >
        {open && (
          <BulkForm orderIds={orderIds} onQueued={onQueued} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BulkForm({
  orderIds,
  onQueued,
  onDone,
}: {
  orderIds: string[];
  onQueued: () => void;
  onDone: () => void;
}) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const choices = useCourierChoices(org.id);
  // Couriers that need a delivery area per parcel are booked from each order instead.
  const usable = choices.data?.filter((c) => c.ready && !c.locationRequired) ?? [];
  const perOrder = choices.data?.filter((c) => c.ready && c.locationRequired) ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const accountId = picked ?? (usable.find((c) => c.isDefault) ?? usable[0])?.id ?? '';
  const account = usable.find((c) => c.id === accountId);
  const [weight, setWeight] = useState('');
  const [note, setNote] = useState('');
  const grams = weight.trim() ? parseKg(weight) : null;
  const weightError =
    weight.trim() && account ? weightProblem(grams, account.weightGrams) : undefined;

  const send = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<BulkBookResult>(`/orgs/${org.id}/parcels/bulk`, {
        body: {
          orderIds,
          accountId,
          ...(grams ? { weightGrams: grams } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: commerceKeys.orders(org.id) });
      if (r.queued.length) onQueued();
    },
  });

  if (choices.isPending) return <Skeleton className="h-40" />;
  if (choices.isError) return <Alert tone="danger">{errorMessage(choices.error)}</Alert>;

  if (send.data) {
    const r = send.data;
    return (
      <div className="grid gap-4">
        {r.queued.length > 0 && (
          <Alert
            tone="success"
            title={`${r.queued.length} sent to ${account?.name ?? 'the courier'}`}
          >
            They show as “Waiting to send” until the courier answers, usually within a minute.
          </Alert>
        )}
        {r.skipped.length > 0 && (
          <Alert tone="warning" title={`${r.skipped.length} not sent`}>
            <ul className="mt-1 grid gap-1">
              {r.skipped.map((s) => (
                <li key={s.orderId}>
                  <span className="font-mono">{s.number ?? s.orderId}</span>: {s.reason}
                </li>
              ))}
            </ul>
          </Alert>
        )}
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </div>
    );
  }

  if (!usable.length)
    return (
      <div className="grid gap-4">
        <Alert tone="info">
          {perOrder.length
            ? `${perOrder.map((c) => c.name).join(', ')} needs a delivery area for each parcel. Send those orders from each order’s page.`
            : 'No courier is ready to book. Connect one in Settings › Couriers.'}
        </Alert>
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>
            Close
          </Button>
        </DialogFooter>
      </div>
    );

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!weightError) send.mutate();
      }}
    >
      {send.isError && <Alert tone="danger">{errorMessage(send.error)}</Alert>}
      <Field label="Courier" htmlFor="bb-account">
        <NativeSelect id="bb-account" value={accountId} onChange={(e) => setPicked(e.target.value)}>
          {usable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.isDefault ? ' · default' : ''}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {perOrder.length > 0 && (
        <p className="text-[13px] text-muted-foreground">
          {perOrder.map((c) => c.name).join(', ')} needs a delivery area for each parcel, so it is
          not offered here.
        </p>
      )}
      <Field
        label="Weight of each parcel (kg)"
        htmlFor="bb-weight"
        optional
        error={weightError ?? undefined}
        hint={
          account ? `Empty: ${formatWeight(account.defaultWeightGrams)}, the usual weight.` : ''
        }
      >
        <Input
          id="bb-weight"
          inputMode="decimal"
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
        />
      </Field>
      <Field label="Note for the rider" htmlFor="bb-note" optional>
        <Textarea
          id="bb-note"
          rows={2}
          maxLength={250}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={send.isPending} disabled={!accountId}>
          Send {orderIds.length} to {account?.providerName ?? 'courier'}
        </Button>
      </DialogFooter>
    </form>
  );
}
