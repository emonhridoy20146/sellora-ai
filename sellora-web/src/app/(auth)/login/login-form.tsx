'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthCard } from '@/components/auth/auth-card';
import { CodeInput } from '@/components/auth/code-input';
import { PasswordInput } from '@/components/auth/password-input';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { LoginResult } from '@/lib/api/types';

const credentials = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = () => {
    queryClient.clear();
    router.replace(next);
    router.refresh();
  };

  const form = useForm<z.infer<typeof credentials>>({
    resolver: zodResolver(credentials),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await api<LoginResult>('/auth/login', { body: values, noRefresh: true });
      if (res.status === 'mfa_required') setMfaToken(res.mfaToken);
      else done();
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  if (mfaToken)
    return <MfaStep mfaToken={mfaToken} onDone={done} onBack={() => setMfaToken(null)} />;

  return (
    <AuthCard
      title="Welcome back"
      description="Sign in to manage your shop."
      footer={
        <>
          New here?{' '}
          <Link href="/signup" className="font-medium text-primary hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            aria-invalid={Boolean(form.formState.errors.email)}
            {...form.register('email')}
          />
        </Field>
        <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            aria-invalid={Boolean(form.formState.errors.password)}
            {...form.register('password')}
          />
        </Field>
        <div className="-mt-1 text-right text-sm">
          <Link href="/forgot-password" className="text-muted-foreground hover:text-foreground">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}

function MfaStep({
  mfaToken,
  onDone,
  onBack,
}: {
  mfaToken: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AuthCard
      title="Two-step verification"
      description={
        useRecovery
          ? 'Enter one of the recovery codes you saved when you turned on two-step verification.'
          : 'Enter the 6-digit code from your authenticator app.'
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          api('/auth/login/mfa', {
            body: useRecovery ? { mfaToken, recoveryCode: value } : { mfaToken, code: value },
            noRefresh: true,
          })
            .then(onDone)
            .catch((err: unknown) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={useRecovery ? 'Recovery code' : 'Code'} htmlFor="code">
          {useRecovery ? (
            <Input
              id="code"
              autoComplete="off"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono"
            />
          ) : (
            <CodeInput
              id="code"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
            />
          )}
        </Field>
        <Button
          type="submit"
          loading={busy}
          disabled={useRecovery ? value.trim().length < 8 : value.length !== 6}
        >
          Verify
        </Button>
        <div className="flex justify-between text-sm">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            Back
          </button>
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => {
              setUseRecovery((r) => !r);
              setValue('');
            }}
          >
            {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
          </button>
        </div>
      </form>
    </AuthCard>
  );
}
