'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { PasswordInput } from '@/components/auth/password-input';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Spinner } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { AdminAuthFrame } from '../admin-frame';

export function AdminSetup({ token }: { token: string }) {
  const preview = useQuery({
    queryKey: ['platform-setup', token],
    queryFn: () =>
      api<{ email: string; name: string; role: string }>('/platform/auth/setup/preview', {
        body: { token },
        noRefresh: true,
      }),
    enabled: token.length >= 10,
    retry: false,
  });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const save = useMutation({
    mutationFn: () => api('/platform/auth/setup', { body: { token, password }, noRefresh: true }),
    meta: { silent: true },
  });

  return (
    <AdminAuthFrame>
      {!token ? (
        <AuthCard title="Link incomplete">
          <Alert tone="warning">Open the setup link from your email again.</Alert>
        </AuthCard>
      ) : preview.isPending ? (
        <Spinner />
      ) : preview.isError ? (
        <AuthCard title="This link does not work">
          <Alert tone="danger">
            {errorMessage(preview.error)} Ask the platform owner for a new link.
          </Alert>
        </AuthCard>
      ) : save.isSuccess ? (
        <AuthCard title="Password saved">
          <div className="grid gap-4">
            <Alert tone="success">Now sign in. You will set up two-step verification next.</Alert>
            <Button asChild>
              <Link href="/admin/login">Sign in</Link>
            </Button>
          </div>
        </AuthCard>
      ) : (
        <AuthCard
          title={`Welcome, ${preview.data.name}`}
          description={`Choose a password for ${preview.data.email} (${preview.data.role}).`}
        >
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
            <Field
              label="Password"
              htmlFor="pw"
              hint="At least 14 characters. Use a password manager."
            >
              <PasswordInput
                id="pw"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field
              label="Repeat it"
              htmlFor="pw2"
              error={confirm && confirm !== password ? 'The passwords do not match' : undefined}
            >
              <PasswordInput
                id="pw2"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              loading={save.isPending}
              disabled={password.length < 14 || password !== confirm}
            >
              Save password
            </Button>
          </form>
        </AuthCard>
      )}
    </AdminAuthFrame>
  );
}
