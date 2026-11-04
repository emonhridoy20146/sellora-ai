'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { CodeInput } from '@/components/auth/code-input';
import { PasswordInput } from '@/components/auth/password-input';
import { RecoveryCodes, TotpCodeField, TotpQr } from '@/components/auth/totp-setup';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PlatformLoginResult } from '@/lib/api/types';
import { AdminAuthFrame } from '../admin-frame';

type Step =
  | { kind: 'password' }
  | { kind: 'code'; mfaToken: string }
  | { kind: 'setup'; setupToken: string; secret?: string; otpauthUrl?: string }
  | { kind: 'codes'; codes: string[] };

/**
 * Platform sign-in. Two-step verification is mandatory: first sign-in sets it up, every
 * sign-in after asks for the code.
 */
export function AdminLogin({ next }: { next: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  const finish = () => {
    queryClient.clear();
    router.replace(next);
  };

  return (
    <AdminAuthFrame>
      {step.kind === 'password' && (
        <AuthCard
          title="Platform sign in"
          description="For the Sellora team only. Every action is recorded."
        >
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const r = await api<PlatformLoginResult>('/platform/auth/login', {
                  body: { email, password },
                  noRefresh: true,
                });
                if (r.status === 'mfa_required') setStep({ kind: 'code', mfaToken: r.mfaToken });
                else {
                  const s = await api<{ secret: string; otpauthUrl: string }>(
                    '/platform/auth/mfa/setup',
                    {
                      body: { setupToken: r.setupToken },
                      noRefresh: true,
                    },
                  );
                  setStep({ kind: 'setup', setupToken: r.setupToken, ...s });
                }
              });
            }}
          >
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <PasswordInput
                id="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" loading={busy}>
              Continue
            </Button>
          </form>
        </AuthCard>
      )}

      {step.kind === 'code' && (
        <AuthCard
          title="Two-step verification"
          description={
            recovery ? 'Enter a recovery code.' : 'Enter the code from your authenticator app.'
          }
        >
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api('/platform/auth/login/mfa', {
                  body: recovery
                    ? { mfaToken: step.mfaToken, recoveryCode: code }
                    : { mfaToken: step.mfaToken, code },
                  noRefresh: true,
                });
                finish();
              });
            }}
          >
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label={recovery ? 'Recovery code' : 'Code'} htmlFor="code">
              {recovery ? (
                <Input
                  id="code"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="font-mono"
                />
              ) : (
                <CodeInput
                  id="code"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
              )}
            </Field>
            <Button
              type="submit"
              loading={busy}
              disabled={recovery ? code.trim().length < 8 : code.length !== 6}
            >
              Sign in
            </Button>
            <button
              type="button"
              className="text-sm text-primary hover:underline"
              onClick={() => {
                setRecovery((r) => !r);
                setCode('');
              }}
            >
              {recovery ? 'Use authenticator code' : 'Use a recovery code'}
            </button>
          </form>
        </AuthCard>
      )}

      {step.kind === 'setup' && step.secret && step.otpauthUrl && (
        <AuthCard
          title="Set up two-step verification"
          description="Platform accounts must use an authenticator app."
        >
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const r = await api<{ recoveryCodes: string[] }>('/platform/auth/mfa/activate', {
                  body: { setupToken: step.setupToken, code },
                  noRefresh: true,
                });
                setStep({ kind: 'codes', codes: r.recoveryCodes });
              });
            }}
          >
            <TotpQr otpauthUrl={step.otpauthUrl} secret={step.secret} />
            {error && <Alert tone="danger">{error}</Alert>}
            <TotpCodeField value={code} onChange={setCode} />
            <Button type="submit" loading={busy} disabled={code.length !== 6}>
              Turn on and sign in
            </Button>
          </form>
        </AuthCard>
      )}

      {step.kind === 'codes' && (
        <AuthCard title="Save your recovery codes">
          <div className="grid gap-4">
            <RecoveryCodes codes={step.codes} account={email} />
            <Button onClick={finish}>I saved them, continue</Button>
          </div>
        </AuthCard>
      )}
    </AdminAuthFrame>
  );
}
