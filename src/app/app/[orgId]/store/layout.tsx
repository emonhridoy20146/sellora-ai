'use client';

import { Store } from 'lucide-react';
import Link from 'next/link';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/** Online store pages need the storefront module on the plan and permission to see stores. */
export default function StoreLayout({ children }: { children: React.ReactNode }) {
  const { org, can, modules } = useOrg();
  if (!can('stores.view'))
    return (
      <EmptyState icon={Store} title="You cannot see the online store">
        Ask the owner or an admin for access.
      </EmptyState>
    );
  if (modules !== null && !modules.includes('storefront'))
    return (
      <EmptyState
        icon={Store}
        title="Your plan does not include an online store"
        action={
          can('billing.view') ? (
            <Button asChild>
              <Link href={`/app/${org.id}/billing/plans`}>See plans</Link>
            </Button>
          ) : undefined
        }
      >
        Choose a plan with an online store to build your own shop at your own web address.
      </EmptyState>
    );
  return <>{children}</>;
}
