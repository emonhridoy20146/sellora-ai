'use client';

import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api/errors';

/** A load error, or an upgrade prompt when the plan does not include the feature. */
export function PageError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { org, can } = useOrg();
  if (error instanceof ApiError && error.code === 'module_not_in_plan') {
    return (
      <EmptyState
        icon={Lock}
        title="Not included in your plan"
        action={
          can('billing.view') ? (
            <Button asChild>
              <Link href={`/app/${org.id}/billing/plans`}>See plans</Link>
            </Button>
          ) : undefined
        }
      >
        {error.message}
      </EmptyState>
    );
  }
  return <ErrorState error={error} onRetry={onRetry} />;
}
