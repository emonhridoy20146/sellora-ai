'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { qk } from '@/lib/api/queries';
import type { BusinessCategory, Organization } from '@/lib/api/types';
import { applyServerErrors } from '@/lib/forms';
import { useState } from 'react';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter the business name').max(120),
  category: z.string().min(1),
  phone: z.string().trim().max(32).optional(),
  currency: z.string().length(3),
  timezone: z.string().min(1),
});
type Values = z.infer<typeof schema>;

const CURRENCIES = [
  { code: 'BDT', label: 'Bangladeshi taka (৳)', timezone: 'Asia/Dhaka', country: 'BD' },
  { code: 'USD', label: 'US dollar ($)', timezone: 'America/New_York', country: 'US' },
  { code: 'INR', label: 'Indian rupee (₹)', timezone: 'Asia/Kolkata', country: 'IN' },
  { code: 'GBP', label: 'British pound (£)', timezone: 'Europe/London', country: 'GB' },
  { code: 'EUR', label: 'Euro (€)', timezone: 'Europe/Berlin', country: 'DE' },
  { code: 'MYR', label: 'Malaysian ringgit (RM)', timezone: 'Asia/Kuala_Lumpur', country: 'MY' },
  { code: 'SGD', label: 'Singapore dollar (S$)', timezone: 'Asia/Singapore', country: 'SG' },
];

export function CreateBusinessForm({ onCancel }: { onCancel?: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const categories = useQuery({
    queryKey: ['catalog', 'business-categories'],
    queryFn: () => api<BusinessCategory[]>('/catalog/business-categories'),
    staleTime: Infinity,
  });
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      category: 'fashion',
      phone: '',
      currency: 'BDT',
      timezone: 'Asia/Dhaka',
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const c = CURRENCIES.find((x) => x.code === v.currency);
    try {
      const org = await api<Organization>('/orgs', {
        body: {
          name: v.name,
          category: v.category,
          phone: v.phone || undefined,
          currency: v.currency,
          country: c?.country ?? 'BD',
          timezone: v.timezone,
          locale: 'en',
        },
      });
      await queryClient.invalidateQueries({ queryKey: qk.me });
      router.push(`/app/${org.id}`);
    } catch (err) {
      if (
        !applyServerErrors(err, form.setError, [
          'name',
          'category',
          'phone',
          'currency',
          'timezone',
        ])
      )
        setError(errorMessage(err));
    }
  });

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Business name" htmlFor="name" error={errors.name?.message}>
        <Input
          id="name"
          autoFocus
          placeholder="e.g. Dhaka Fashion House"
          {...form.register('name')}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What do you sell?" htmlFor="category" error={errors.category?.message}>
          <NativeSelect id="category" {...form.register('category')}>
            {(categories.data ?? [{ key: 'fashion', label: { en: 'Fashion', bn: '' } }]).map(
              (c) => (
                <option key={c.key} value={c.key}>
                  {c.label.en}
                </option>
              ),
            )}
          </NativeSelect>
        </Field>
        <Field label="Business phone" htmlFor="phone" optional error={errors.phone?.message}>
          <Input id="phone" type="tel" placeholder="01XXXXXXXXX" {...form.register('phone')} />
        </Field>
        <Field
          label="Currency"
          htmlFor="currency"
          hint="Prices, orders and your wallet use this currency. It cannot be changed later."
        >
          <NativeSelect
            id="currency"
            {...form.register('currency', {
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                const c = CURRENCIES.find((x) => x.code === e.target.value);
                if (c) form.setValue('timezone', c.timezone);
              },
            })}
          >
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Time zone" htmlFor="timezone" error={errors.timezone?.message}>
          <NativeSelect id="timezone" {...form.register('timezone')}>
            {Intl.supportedValuesOf('timeZone').map((tz) => (
              <option key={tz} value={tz}>
                {tz.replaceAll('_', ' ')}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={form.formState.isSubmitting}>
          Create business
        </Button>
      </div>
    </form>
  );
}
