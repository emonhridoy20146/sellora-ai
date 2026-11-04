'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthCard } from '@/components/auth/auth-card';
import { PasswordInput } from '@/components/auth/password-input';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { applyServerErrors } from '@/lib/forms';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(120),
  email: z.email('Enter a valid email address'),
  phone: z.string().trim().max(20).optional(),
  password: z.string().min(10, 'Use at least 10 characters').max(128),
  acceptTerms: z.literal(true, { message: 'Please accept the terms to continue' }),
});
type Values = z.infer<typeof schema>;
const FIELDS = ['name', 'email', 'phone', 'password', 'acceptTerms'] as const;

export function SignupForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      email: '',
      phone: '',
      password: '',
      acceptTerms: false as unknown as true,
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api('/auth/signup', {
        body: { ...values, phone: values.phone || undefined, locale: 'en' },
        noRefresh: true,
      });
      setSentTo(values.email);
    } catch (err) {
      if (!applyServerErrors(err, form.setError, FIELDS)) setError(errorMessage(err));
    }
  });

  if (sentTo) return <CheckEmail email={sentTo} />;

  return (
    <AuthCard
      title="Start selling smarter"
      description="Free trial of every feature. No card needed."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Your name" htmlFor="name" error={errors.name?.message}>
          <Input
            id="name"
            autoComplete="name"
            autoFocus
            aria-invalid={Boolean(errors.name)}
            {...form.register('name')}
          />
        </Field>
        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-invalid={Boolean(errors.email)}
            {...form.register('email')}
          />
        </Field>
        <Field label="Mobile number" htmlFor="phone" optional error={errors.phone?.message}>
          <Input
            id="phone"
            type="tel"
            autoComplete="tel"
            placeholder="01XXXXXXXXX"
            aria-invalid={Boolean(errors.phone)}
            {...form.register('phone')}
          />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          error={errors.password?.message}
          hint="At least 10 characters. A short sentence is easy to remember and hard to guess."
        >
          <PasswordInput
            id="password"
            autoComplete="new-password"
            aria-invalid={Boolean(errors.password)}
            {...form.register('password')}
          />
        </Field>
        <div className="grid gap-1.5">
          <div className="flex items-start gap-2.5">
            <Controller
              control={form.control}
              name="acceptTerms"
              render={({ field }) => (
                <Checkbox
                  id="acceptTerms"
                  className="mt-0.5"
                  checked={field.value === true}
                  onCheckedChange={(c) => field.onChange(c === true)}
                  aria-invalid={Boolean(errors.acceptTerms)}
                />
              )}
            />
            <label htmlFor="acceptTerms" className="text-sm leading-snug text-muted-foreground">
              I agree to the{' '}
              <Link href="/legal/terms" className="text-primary hover:underline">
                terms of service
              </Link>{' '}
              and{' '}
              <Link href="/legal/privacy" className="text-primary hover:underline">
                privacy policy
              </Link>
              .
            </label>
          </div>
          {errors.acceptTerms && (
            <p role="alert" className="text-[13px] text-destructive">
              {errors.acceptTerms.message}
            </p>
          )}
        </div>
        <Button type="submit" loading={form.formState.isSubmitting}>
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}

function CheckEmail({ email }: { email: string }) {
  const [resent, setResent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AuthCard title="Check your email" description={`We sent a verification link to ${email}.`}>
      <div className="grid gap-4 text-sm">
        <div className="flex justify-center">
          <div className="rounded-full bg-info-soft p-3">
            <MailCheck className="size-6 text-primary" aria-hidden />
          </div>
        </div>
        <p className="text-center text-muted-foreground">
          Open the link to verify your address, then sign in. The link works for 24 hours.
        </p>
        <Button
          variant="outline"
          loading={busy}
          disabled={resent}
          onClick={() => {
            setBusy(true);
            api('/auth/verify-email/resend', { body: { email }, noRefresh: true })
              .then(() => setResent(true))
              .finally(() => setBusy(false));
          }}
        >
          {resent ? 'Sent again' : 'Resend the link'}
        </Button>
        <Button asChild>
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    </AuthCard>
  );
}
