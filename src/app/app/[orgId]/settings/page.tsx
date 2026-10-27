'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { qk } from '@/lib/api/queries';
import type { BusinessCategory } from '@/lib/api/types';
import { applyServerErrors } from '@/lib/forms';

const optional = (max: number) => z.string().trim().max(max);
const schema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  legalName: optional(200),
  category: z.string(),
  timezone: z.string(),
  locale: z.enum(['en', 'bn']),
  orderNumberPrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,6}$/, 'Use 1 to 6 letters or digits'),
  phone: optional(32),
  email: z.union([z.literal(''), z.email('Enter a valid email')]),
  address: optional(500),
  website: z.union([z.literal(''), z.url('Enter a full address like https://myshop.com')]),
});
type Values = z.infer<typeof schema>;
const FIELDS = [
  'name',
  'legalName',
  'category',
  'timezone',
  'locale',
  'orderNumberPrefix',
  'phone',
  'email',
  'address',
  'website',
] as const;

export default function SettingsPage() {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const editable = can('org.settings.manage');
  const [error, setError] = useState<string | null>(null);
  const categories = useQuery({
    queryKey: ['catalog', 'business-categories'],
    queryFn: () => api<BusinessCategory[]>('/catalog/business-categories'),
    staleTime: Infinity,
  });
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: org.name,
      legalName: org.legalName ?? '',
      category: org.category,
      timezone: org.timezone,
      locale: org.locale,
      orderNumberPrefix: org.settings.orderNumberPrefix,
      phone: org.contact.phone ?? '',
      email: org.contact.email ?? '',
      address: org.contact.address ?? '',
      website: org.contact.website ?? '',
    },
  });
  const e = form.formState.errors;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const orNull = (s: string) => (s.trim() === '' ? null : s.trim());
    try {
      await api(`/orgs/${org.id}`, {
        method: 'PATCH',
        body: {
          name: v.name,
          legalName: orNull(v.legalName),
          category: v.category,
          timezone: v.timezone,
          locale: v.locale,
          orderNumberPrefix: v.orderNumberPrefix.toUpperCase(),
          contact: {
            phone: orNull(v.phone),
            email: orNull(v.email),
            address: orNull(v.address),
            website: orNull(v.website),
          },
        },
      });
      await queryClient.invalidateQueries({ queryKey: qk.me });
      form.reset(v);
      toast.success('Saved.');
    } catch (err) {
      if (!applyServerErrors(err, form.setError, FIELDS, (k) => k.replace(/^contact\./, '')))
        setError(errorMessage(err));
    }
  });

  return (
    <>
      <form onSubmit={onSubmit} noValidate>
        <fieldset disabled={!editable} className="grid gap-6">
          {!editable && (
            <Alert tone="info">Only the owner and admins can change these settings.</Alert>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          <Card>
            <CardHeader>
              <CardTitle>Business</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="name" error={e.name?.message}>
                <Input id="name" {...form.register('name')} />
              </Field>
              <Field
                label="Registered (legal) name"
                htmlFor="legalName"
                optional
                error={e.legalName?.message}
              >
                <Input id="legalName" {...form.register('legalName')} />
              </Field>
              <Field label="Category" htmlFor="category">
                <NativeSelect id="category" {...form.register('category')}>
                  {(
                    categories.data ?? [{ key: org.category, label: { en: org.category, bn: '' } }]
                  ).map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label.en}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field
                label="Order number prefix"
                htmlFor="prefix"
                error={e.orderNumberPrefix?.message}
                hint="Orders will look like SL-1001."
              >
                <Input id="prefix" className="uppercase" {...form.register('orderNumberPrefix')} />
              </Field>
              <Field
                label="Time zone"
                htmlFor="timezone"
                hint="Reports and daily totals follow this time zone."
              >
                <NativeSelect id="timezone" {...form.register('timezone')}>
                  {Intl.supportedValuesOf('timeZone').map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replaceAll('_', ' ')}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Language for customer messages" htmlFor="locale">
                <NativeSelect id="locale" {...form.register('locale')}>
                  <option value="en">English</option>
                  <option value="bn">বাংলা (Bangla)</option>
                </NativeSelect>
              </Field>
              <div className="grid gap-1.5 text-sm sm:col-span-2">
                <p className="text-muted-foreground">
                  Currency <span className="font-medium text-foreground">{org.currency}</span> ·
                  Country <span className="font-medium text-foreground">{org.country}</span> · Web
                  address name <span className="font-mono text-foreground">{org.slug}</span>
                </p>
                <p className="text-[13px] text-muted-foreground">
                  These are fixed once the business exists.
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Contact</CardTitle>
              <CardDescription>Shown on receipts and invoices.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone" htmlFor="phone" optional error={e.phone?.message}>
                <Input id="phone" type="tel" {...form.register('phone')} />
              </Field>
              <Field label="Email" htmlFor="email" optional error={e.email?.message}>
                <Input id="email" type="email" {...form.register('email')} />
              </Field>
              <Field label="Website" htmlFor="website" optional error={e.website?.message}>
                <Input
                  id="website"
                  type="url"
                  placeholder="https://"
                  {...form.register('website')}
                />
              </Field>
              <Field
                label="Address"
                htmlFor="address"
                optional
                error={e.address?.message}
                className="sm:col-span-2"
              >
                <Textarea id="address" {...form.register('address')} />
              </Field>
            </CardContent>
            {editable && (
              <CardFooter className="justify-end">
                <Button
                  type="submit"
                  loading={form.formState.isSubmitting}
                  disabled={!form.formState.isDirty}
                >
                  Save changes
                </Button>
              </CardFooter>
            )}
          </Card>
        </fieldset>
      </form>
    </>
  );
}
