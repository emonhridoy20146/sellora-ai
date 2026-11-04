'use client';

import { useQueryClient } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageError } from '@/components/commerce/page-error';
import { landingKeys, useLandingVersions } from '@/components/landing/hooks';
import { useOrg } from '@/components/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { LandingPage } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';

export default function LandingVersionsPage() {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const { pageId } = useParams<{ pageId: string }>();
  const versions = useLandingVersions(org.id, pageId);
  const [restoring, setRestoring] = useState<number | null>(null);

  const restore = async (version: number) => {
    const next = await api<LandingPage>(
      `/orgs/${org.id}/landing-pages/${pageId}/versions/${version}/restore`,
      { method: 'POST' },
    ).catch((err: unknown) => {
      toast.error(errorMessage(err));
      throw err;
    });
    queryClient.setQueryData(landingKeys.page(org.id, pageId), next);
    toast.success(`Version ${version} is in the editor. Publish it to show it again.`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Published versions</CardTitle>
        <CardDescription>
          Each version shoppers have seen, newest first (the last 20 are kept). Copying one back
          replaces your draft; shoppers see it only after you publish it again.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 py-0">
        {versions.isPending ? (
          <Skeleton className="m-5 h-32" />
        ) : versions.isError ? (
          <PageError error={versions.error} onRetry={() => void versions.refetch()} />
        ) : versions.data.items.length === 0 ? (
          <EmptyState icon={History} title="Nothing published yet">
            Versions appear here once the page has gone live.
          </EmptyState>
        ) : (
          <ul className="divide-y">
            {versions.data.items.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    Version {v.version}
                    {v.live && <Badge tone="success">Live</Badge>}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Published {formatDateTime(v.publishedAt, org.timezone)}
                    {v.autoApproved ? ' · approved automatically' : ' · approved by Sellora'}
                  </p>
                </div>
                {can('stores.manage') && (
                  <Button variant="outline" size="sm" onClick={() => setRestoring(v.version)}>
                    Copy into the draft
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(o) => !o && setRestoring(null)}
        title={`Copy version ${restoring ?? ''} into the draft?`}
        description="Your current draft is replaced, including changes you have not published. The live page does not change until you publish."
        confirmLabel="Copy into the draft"
        onConfirm={() => (restoring !== null ? restore(restoring) : undefined)}
      />
    </Card>
  );
}
