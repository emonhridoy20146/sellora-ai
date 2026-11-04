'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/empty-state';
import { onSessionExpired, type Realm } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';

/**
 * Shows children once the signed-in user is loaded; sends signed-out people to the right
 * sign-in page (keeping where they were going).
 */
export function SessionGate({
  realm,
  query,
  children,
}: {
  realm: Realm;
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const loginPath = realm === 'platform' ? '/admin/login' : '/login';
  const signedOut = query.isError && query.error instanceof ApiError && query.error.status === 401;

  useEffect(() => {
    const toLogin = () => router.replace(`${loginPath}?next=${encodeURIComponent(pathname)}`);
    if (signedOut) toLogin();
    return onSessionExpired((r) => r === realm && toLogin());
  }, [signedOut, router, pathname, loginPath, realm]);

  if (query.isPending || signedOut)
    return <Spinner className="min-h-dvh" label="Loading your account" />;
  if (query.isError)
    return (
      <div className="min-h-dvh pt-24">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  return <>{children}</>;
}
