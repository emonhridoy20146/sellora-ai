'use client';

import { useOrg } from '@/components/org-context';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { TabNav } from '@/components/ui/tab-nav';

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  const { org, can } = useOrg();
  const base = `/app/${org.id}/staff`;
  if (!can('org.members.view')) return <EmptyState title="Your role cannot see the staff list" />;
  return (
    <>
      <PageHeader
        title="Staff"
        description="Who can work in this business, and what each person can do."
      />
      <TabNav
        tabs={[
          { href: base, label: 'Members', exact: true },
          { href: `${base}/invitations`, label: 'Invitations' },
          { href: `${base}/roles`, label: 'Roles' },
        ]}
      />
      {children}
    </>
  );
}
