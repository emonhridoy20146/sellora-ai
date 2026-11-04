'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { PasswordInput } from '@/components/auth/password-input';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';

export function ResetPassword({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && confirm !== password;

  if (done) {
    return (
      <AuthCard title="Password changed">
        <div className="grid gap-4">
          <Alert tone="success">
            Your password was changed and you were signed out on every device.
          </Alert>
          <Button asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Choose a new password">
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (mismatch) return;
          setBusy(true);
          setError(null);
          api('/auth/password/reset', { body: { token, password }, noRefresh: true })
            .then(() => setDone(true))
            .catch((err: unknown) =>
              setError(
                err instanceof ApiError && err.fieldErrors().password
                  ? err.fieldErrors().password!
                  : errorMessage(err),
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        {!token && (
          <Alert tone="warning">This link is missing its code. Ask for a new reset link.</Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="New password" htmlFor="password" hint="At least 10 characters.">
          <PasswordInput
            id="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field
          label="Repeat it"
          htmlFor="confirm"
          error={mismatch ? 'The passwords do not match' : undefined}
        >
          <PasswordInput
            id="confirm"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button type="submit" loading={busy} disabled={!token || password.length < 10 || mismatch}>
          Save password
        </Button>
      </form>
    </AuthCard>
  );
}
