'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { qk } from '@/lib/api/queries';
import type { InvitationPreview, Me } from '@/lib/api/types';

export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () =>
      api<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`, { noRefresh: true }),
  });
  const me = useQuery({ queryKey: qk.me, queryFn: () => api<Me>('/auth/me'), retry: false });
  const accept = useMutation({
    mutationFn: () => api<{ orgId: string }>('/invitations/accept', { body: { token } }),
    meta: { silent: true },
    onSuccess: async ({ orgId }) => {
      await queryClient.invalidateQueries({ queryKey: qk.me });
      router.replace(`/app/${orgId}`);
    },
  });
  const here = encodeURIComponent(`/invite/${token}`);

  if (preview.isPending) return <Spinner />;
  if (preview.isError || preview.data.status !== 'pending') {
    return (
      <AuthCard title="Invitation not available">
        <Alert tone="warning">
          {preview.isError
            ? errorMessage(preview.error)
            : `This invitation was already ${preview.data.status}.`}{' '}
          Ask the shop owner to send a new one.
        </Alert>
      </AuthCard>
    );
  }
  const inv = preview.data;
  return (
    <AuthCard title={`Join ${inv.orgName}`} description={`You were invited as ${inv.roleName}.`}>
      <div className="grid gap-4 text-sm">
        <div className="flex items-center gap-3 rounded-lg bg-muted p-3">
          <Users className="size-5 text-muted-foreground" aria-hidden />
          <p>
            The invitation is for <span className="font-medium">{inv.email}</span>. Sign in with
            that email to accept it.
          </p>
        </div>
        {accept.isError && <Alert tone="danger">{errorMessage(accept.error)}</Alert>}
        {me.isSuccess ? (
          <>
            <p className="text-muted-foreground">
              Signed in as <span className="font-medium text-foreground">{me.data.user.email}</span>
              .
            </p>
            <Button loading={accept.isPending} onClick={() => accept.mutate()}>
              Accept and open the dashboard
            </Button>
          </>
        ) : me.isPending ? (
          <Spinner className="p-4" />
        ) : (
          <>
            <Button asChild>
              <Link href={`/login?next=${here}`}>Sign in to accept</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/signup">Create an account first</Link>
            </Button>
          </>
        )}
      </div>
    </AuthCard>
  );
}
