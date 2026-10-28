'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { commerceKeys } from '@/components/commerce/hooks';
import { MoneyInput } from '@/components/commerce/money-input';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { CourierChoice, Order, Parcel, ParcelLocation } from '@/lib/api/types';
import { addressLines } from '@/lib/commerce';
import { kgInput, parseKg, weightProblem } from '@/lib/couriers';
import { minorDigits, minorToInput, parseMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { courierKeys, useCourierChoices, useCourierLocations } from './data';

function choiceLabel(c: CourierChoice): string {
  const why = !c.enabled
    ? ' (turned off)'
    : !c.ready
      ? ' (needs a pickup store)'
      : c.status === 'error'
        ? ' (not working)'
        : '';
  return `${c.name}${c.isDefault ? ' · default' : ''}${why}`;
}

/** Pathao: city, then zone, then area, from Pathao's own lists. */
function CityZoneArea({
  accountId,
  value,
  onChange,
}: {
  accountId: string;
  value: ParcelLocation;
  onChange: (v: ParcelLocation) => void;
}) {
  const { org } = useOrg();
  const cities = useCourierLocations(org.id, accountId, 'city');
  const zones = useCourierLocations(org.id, accountId, 'zone', {
    parent: value.cityId,
    enabled: Boolean(value.cityId),
  });
  const areas = useCourierLocations(org.id, accountId, 'area', {
    parent: value.zoneId,
    enabled: Boolean(value.zoneId),
  });
  const error = cities.error ?? zones.error ?? areas.error;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {error && (
        <Alert tone="warning" className="sm:col-span-3">
          {errorMessage(error)} The courier can still place the parcel from the written address.
        </Alert>
      )}
      <Field label="City" htmlFor="bk-city">
        <NativeSelect
          id="bk-city"
          value={value.cityId ?? ''}
          disabled={cities.isPending}
          onChange={(e) => {
            const c = cities.data?.find((x) => x.id === Number(e.target.value));
            onChange(c ? { cityId: c.id, cityName: c.name } : {});
          }}
        >
          <option value="">{cities.isPending ? 'Loading…' : 'From the address'}</option>
          {cities.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Zone" htmlFor="bk-zone">
        <NativeSelect
          id="bk-zone"
          value={value.zoneId ?? ''}
          disabled={!value.cityId || zones.isPending}
          onChange={(e) => {
            const z = zones.data?.find((x) => x.id === Number(e.target.value));
            onChange({
              cityId: value.cityId,
              cityName: value.cityName,
              ...(z ? { zoneId: z.id, zoneName: z.name } : {}),
            });
          }}
        >
          <option value="">Choose a zone</option>
          {zones.data?.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Area" htmlFor="bk-area" optional>
        <NativeSelect
          id="bk-area"
          value={value.areaId ?? ''}
          disabled={!value.zoneId || areas.isPending}
          onChange={(e) => {
            const a = areas.data?.find((x) => x.id === Number(e.target.value));
            const { areaId: _id, areaName: _name, ...rest } = value;
            onChange(a ? { ...rest, areaId: a.id, areaName: a.name } : rest);
          }}
        >
          <option value="">Any area</option>
          {areas.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </div>
  );
}

/** RedX: one delivery area, searched by name or post code. */
function AreaSearch({
  accountId,
  initialSearch,
  value,
  onChange,
  error,
}: {
  accountId: string;
  initialSearch: string;
  value: ParcelLocation;
  onChange: (v: ParcelLocation) => void;
  error?: string;
}) {
  const { org } = useOrg();
  const [search, setSearch] = useState(initialSearch);
  const q = useDebounced(search.trim());
  const areas = useCourierLocations(org.id, accountId, 'area', { q: q || undefined });
  return (
    <div className="grid gap-2">
      <Field
        label="Delivery area"
        htmlFor="bk-area-q"
        error={error}
        hint={
          value.areaId
            ? `Chosen: ${value.areaName}`
            : 'Search by area name or post code, then choose one.'
        }
      >
        <div className="relative">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input
            id="bk-area-q"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Dhanmondi or 1209"
          />
        </div>
      </Field>
      <div
        role="radiogroup"
        aria-label="Delivery areas"
        className="max-h-44 overflow-y-auto rounded-md border"
      >
        {areas.isPending ? (
          <Skeleton className="m-2 h-16" />
        ) : areas.isError ? (
          <p className="p-3 text-sm text-destructive">{errorMessage(areas.error)}</p>
        ) : areas.data.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No area matches.</p>
        ) : (
          areas.data.map((a) => {
            const on = value.areaId === a.id;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange({ areaId: a.id, areaName: a.name })}
                className={cn(
                  'flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0',
                  on ? 'bg-info-soft font-medium text-primary' : 'hover:bg-muted',
                )}
              >
                <span>{a.name}</span>
                {a.hint && <span className="text-xs text-muted-foreground">{a.hint}</span>}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Sends one order to a courier now and shows the courier's answer. */
export function BookDialog({
  order,
  open,
  onOpenChange,
}: {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wide
        title={`Send ${order.number} to a courier`}
        description="The courier gets the customer’s name, phone and address from the order."
      >
        {open && <BookForm order={order} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function BookForm({ order, onDone }: { order: Order; onDone: () => void }) {
  const { org, can } = useOrg();
  const qc = useQueryClient();
  const choices = useCourierChoices(org.id);
  const usable = choices.data?.filter((c) => c.ready) ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const accountId = picked ?? (usable.find((c) => c.isDefault) ?? usable[0])?.id ?? '';
  const account = choices.data?.find((c) => c.id === accountId);
  const c = order.currency;
  const [cod, setCod] = useState(minorToInput(order.dueMinor, c));
  const [weight, setWeight] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [location, setLocation] = useState<ParcelLocation>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<string | null>(null);

  const weightText = weight ?? (account ? kgInput(account.defaultWeightGrams) : '');
  const grams = parseKg(weightText);
  const codMinor = parseMoney(cod || '0', c);
  const whole = 10 ** minorDigits(c);
  const codError =
    codMinor === null
      ? 'Enter an amount'
      : codMinor % whole !== 0
        ? 'Couriers collect whole taka only'
        : undefined;
  const weightError = account ? weightProblem(grams, account.weightGrams) : null;

  const book = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<Parcel>(`/orgs/${org.id}/orders/${order.id}/parcels`, {
        body: {
          accountId,
          codMinor,
          weightGrams: grams,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(account?.location !== 'none' && Object.keys(location).length ? { location } : {}),
        },
      }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: courierKeys.parcels(org.id, order.id) });
      void qc.invalidateQueries({ queryKey: commerceKeys.orders(org.id) });
      if (p.status === 'booked')
        toast.success(`Booked with ${p.providerName}. Consignment ${p.consignmentId ?? ''}.`);
      else
        toast.warning(
          `${p.providerName} did not answer clearly. Sellora is checking whether the booking went through.`,
        );
      onDone();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'courier_refused') {
        setRefused(err.message);
        void qc.invalidateQueries({ queryKey: courierKeys.parcels(org.id, order.id) });
      } else if (err instanceof ApiError && err.errors.length) {
        const fe = err.fieldErrors();
        setErrors({ ...fe, ...(fe.codMinor ? { cod: fe.codMinor } : {}) });
      } else setErrors({ _: errorMessage(err) });
    },
  });

  if (choices.isPending) return <Skeleton className="h-48" />;
  if (choices.isError) return <Alert tone="danger">{errorMessage(choices.error)}</Alert>;
  if (!usable.length)
    return (
      <div className="grid gap-4">
        <Alert tone="info" title="No courier ready to book">
          {choices.data.length
            ? 'Turn a courier account on, or choose its pickup store, in Settings › Couriers.'
            : 'Connect your Steadfast, Pathao or RedX account first.'}
        </Alert>
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>
            Close
          </Button>
          {can('org.integrations.manage') && (
            <Button asChild>
              <Link href={`/app/${org.id}/settings/couriers`}>Open courier settings</Link>
            </Button>
          )}
        </DialogFooter>
      </div>
    );

  const addr = order.shippingAddress;
  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setRefused(null);
        const local: Record<string, string> = {};
        if (codError) local.cod = codError;
        if (weightError) local.weight = weightError;
        if (account?.locationRequired && !location.areaId)
          local.location = 'Choose the delivery area';
        setErrors(local);
        if (Object.keys(local).length === 0) book.mutate();
      }}
    >
      {refused && (
        <Alert
          tone="danger"
          title={`${account?.providerName ?? 'The courier'} refused the booking`}
        >
          {refused} Fix it and try again; the order was not booked.
        </Alert>
      )}
      {errors._ && <Alert tone="danger">{errors._}</Alert>}
      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        <p className="font-medium">{addr.name || order.customer.name}</p>
        <p>{addr.phone || order.customer.phone || 'No phone number'}</p>
        {addressLines(addr).map((l) => (
          <p key={l} className="text-muted-foreground">
            {l}
          </p>
        ))}
        <p className="mt-1 text-xs text-muted-foreground">
          To change these, use Edit on the customer card before sending.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Courier" htmlFor="bk-account">
          <NativeSelect
            id="bk-account"
            value={accountId}
            onChange={(e) => {
              setPicked(e.target.value);
              setWeight(null);
              setLocation({});
            }}
          >
            {choices.data.map((ch) => (
              <option key={ch.id} value={ch.id} disabled={!ch.ready}>
                {choiceLabel(ch)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="Cash to collect"
          htmlFor="bk-cod"
          error={errors.cod}
          hint={codMinor === 0 ? 'Nothing to collect (paid already).' : 'What the customer owes.'}
        >
          <MoneyInput
            id="bk-cod"
            currency={c}
            value={cod}
            onChange={(e) => setCod(e.target.value)}
          />
        </Field>
        <Field label="Weight (kg)" htmlFor="bk-weight" error={errors.weight ?? errors.weightGrams}>
          <Input
            id="bk-weight"
            inputMode="decimal"
            value={weightText}
            onChange={(e) => setWeight(e.target.value)}
          />
        </Field>
      </div>
      {account?.location === 'city_zone_area' && (
        <CityZoneArea accountId={account.id} value={location} onChange={setLocation} />
      )}
      {account?.location === 'area' && (
        <AreaSearch
          key={account.id}
          accountId={account.id}
          initialSearch={addr.area || addr.city || ''}
          value={location}
          onChange={setLocation}
          error={errors.location}
        />
      )}
      <Field label="Note for the rider" htmlFor="bk-note" optional>
        <Textarea
          id="bk-note"
          rows={2}
          maxLength={250}
          value={note}
          placeholder="Call before coming, fragile, …"
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={book.isPending}>
          Book with {account?.providerName ?? 'courier'}
        </Button>
      </DialogFooter>
    </form>
  );
}
