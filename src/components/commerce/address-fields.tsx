'use client';

import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { Address } from '@/lib/api/types';

export const emptyAddress: Address = { line1: '', area: '', city: '', district: '', postcode: '' };

/** Drops empty optional parts so the API stores a clean address. */
export function cleanAddress(a: Address): Address {
  const out: Address = { line1: a.line1.trim() };
  for (const k of ['label', 'name', 'phone', 'area', 'city', 'district', 'postcode'] as const) {
    const v = a[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Delivery address inputs. `errors` uses the API's field paths relative to the address
 * (line1, phone…).
 */
export function AddressFields({
  idPrefix,
  value,
  onChange,
  errors = {},
  withRecipient,
}: {
  idPrefix: string;
  value: Address;
  onChange: (a: Address) => void;
  errors?: Record<string, string | undefined>;
  /** Show the recipient name and phone (when different from the customer). */
  withRecipient?: boolean;
}) {
  const set = (k: keyof Address) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [k]: e.target.value });
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {withRecipient && (
        <>
          <Field
            label="Recipient name"
            htmlFor={id('name')}
            optional
            hint="If someone else receives the parcel"
          >
            <Input
              id={id('name')}
              value={value.name ?? ''}
              onChange={set('name')}
              maxLength={120}
            />
          </Field>
          <Field label="Recipient phone" htmlFor={id('phone')} optional error={errors.phone}>
            <Input
              id={id('phone')}
              type="tel"
              inputMode="tel"
              value={value.phone ?? ''}
              onChange={set('phone')}
            />
          </Field>
        </>
      )}
      <Field
        label="Address"
        htmlFor={id('line1')}
        error={errors.line1}
        className="sm:col-span-2"
        hint="House, road, block or village"
      >
        <Input
          id={id('line1')}
          value={value.line1}
          onChange={set('line1')}
          maxLength={300}
          aria-invalid={Boolean(errors.line1)}
        />
      </Field>
      <Field label="Area or thana" htmlFor={id('area')} optional>
        <Input id={id('area')} value={value.area ?? ''} onChange={set('area')} maxLength={120} />
      </Field>
      <Field label="City" htmlFor={id('city')} optional>
        <Input id={id('city')} value={value.city ?? ''} onChange={set('city')} maxLength={120} />
      </Field>
      <Field label="District" htmlFor={id('district')} optional>
        <Input
          id={id('district')}
          value={value.district ?? ''}
          onChange={set('district')}
          maxLength={120}
        />
      </Field>
      <Field label="Postcode" htmlFor={id('postcode')} optional>
        <Input
          id={id('postcode')}
          value={value.postcode ?? ''}
          onChange={set('postcode')}
          maxLength={20}
        />
      </Field>
    </div>
  );
}
