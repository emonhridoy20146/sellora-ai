'use client';

import { useOrg } from '@/components/org-context';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { TabNav } from '@/components/ui/tab-nav';

export default function BillingLayout({ children }: { children: React.ReactNode }) {
  const { org, can } = useOrg();
  const base = `/app/${org.id}/billing`;
  if (!can('billing.view')) {
    return (
      <EmptyState title="Billing is not available for your role">
        Ask the owner for access.
      </EmptyState>
    );
  }
  return (
    <>
      <PageHeader
        title="Billing & credits"
        description="Your plan, wallet, AI credit usage and receipts."
      />
      <TabNav
        tabs={[
          { href: base, label: 'Overview', exact: true },
          { href: `${base}/plans`, label: 'Plans' },
          { href: `${base}/wallet`, label: 'Wallet' },
          { href: `${base}/usage`, label: 'AI usage' },
          { href: `${base}/invoices`, label: 'Receipts' },
        ]}
      />
      {children}
    </>
  );
}
