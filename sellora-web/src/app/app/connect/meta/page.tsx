'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { PageChooser, metaKeys } from '@/components/channels/meta-connect';
import { SimpleFrame } from '@/components/layout/simple-frame';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MetaLoginResult } from '@/lib/api/types';
import { orgFromState } from '@/lib/channels';

/**
 * Where Facebook Login returns. The code is exchanged once; the page list is then kept
 * under a short-lived session id in the address, so a reload shows it again without
 * reusing the code.
 */
function ConnectMeta() {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const code = params.get('code');
  const state = params.get('state');
  const orgId = params.get('org') ?? orgFromState(state);
  const sessionId = params.get('session');
  const denied = params.get('error');

  // Exchanging the code: once per code, even if React mounts twice.
  const finish = useQuery({
    queryKey: ['meta-login-finish', state],
    queryFn: () =>
      api<MetaLoginResult>(`/orgs/${orgId}/channels/meta/login/finish`, {
        method: 'POST',
        body: { code, state },
      }),
    enabled: Boolean(code && state && orgId && !sessionId),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  useEffect(() => {
    if (!finish.data || !orgId) return;
    qc.setQueryData(metaKeys.session(orgId, finish.data.sessionId), finish.data);
    router.replace(`/app/connect/meta?org=${orgId}&session=${finish.data.sessionId}`);
  }, [finish.data, orgId, qc, router]);

  const session = useQuery({
    queryKey: metaKeys.session(orgId ?? '', sessionId ?? ''),
    queryFn: () => api<MetaLoginResult>(`/orgs/${orgId}/channels/meta/login/${sessionId}`),
    enabled: Boolean(orgId && sessionId),
    retry: false,
    staleTime: 60_000,
  });

  const back = orgId ? `/app/${orgId}/settings/channels` : '/app';
  const result = session.data;
  const error = finish.error ?? session.error;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <Link
          href={back}
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden /> Channels
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Connect Facebook pages</h1>
        <p className="text-sm text-muted-foreground">
          Choose what to connect for each page. Messenger and the page’s Instagram account become
          separate channels in your inbox.
        </p>
      </div>
      {denied ? (
        <Alert tone="warning" title="Facebook login was cancelled">
          Nothing was connected. Start again from Channels when you are ready, and allow every
          permission Facebook asks for.
        </Alert>
      ) : !orgId || (!sessionId && !(code && state)) ? (
        <Alert tone="danger" title="This link is not complete">
          Start connecting from Settings › Channels.
        </Alert>
      ) : error ? (
        <Alert tone="danger" title="Facebook pages could not be loaded">
          {errorMessage(error)}
        </Alert>
      ) : result && sessionId ? (
        <PageChooser orgId={orgId} sessionId={sessionId} pages={result.pages} />
      ) : (
        <div className="grid gap-3" aria-busy>
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}
      <div>
        <Button variant="outline" asChild>
          <Link href={back}>Done</Link>
        </Button>
      </div>
    </div>
  );
}

export default function ConnectMetaPage() {
  return (
    <SimpleFrame>
      <Suspense>
        <ConnectMeta />
      </Suspense>
    </SimpleFrame>
  );
}
