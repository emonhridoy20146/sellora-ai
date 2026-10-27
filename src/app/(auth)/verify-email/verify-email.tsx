'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';

export function VerifyEmail({ token }: { token: string }) {
  const verify = useMutation({
    mutationFn: () => api('/auth/verify-email', { body: { token }, noRefresh: true }),
    meta: { silent: true },
  });
  const started = useRef(false);
  useEffect(() => {
    // The link is single-use: send it once even under React's double effects in dev.
    if (token && !started.current) {
      started.current = true;
      verify.mutate();
    }
  }, [token, verify]);

  if (!token) {
    return (
      <AuthCard title="Link incomplete">
        <Alert tone="warning">
          This verification link is missing its code. Open the link from the email again.
        </Alert>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Verifying your email">
      {verify.isPending || verify.isIdle ? (
        <Spinner />
      ) : verify.isSuccess ? (
        <div className="grid gap-4">
          <Alert tone="success" title="Email verified">
            Your account is ready.
          </Alert>
          <Button asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-4">
          <Alert tone="danger" title="This link did not work">
            {errorMessage(verify.error)} You can ask for a new link from the sign-up page.
          </Alert>
          <Button asChild variant="outline">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </div>
      )}
    </AuthCard>
  );
}
