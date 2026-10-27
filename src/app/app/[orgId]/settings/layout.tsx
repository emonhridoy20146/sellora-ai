'use client';

import { useOrg } from '@/components/org-context';
import { PageHeader } from '@/components/ui/page-header';
import { TabNav } from '@/components/ui/tab-nav';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { org } = useOrg();
  const base = `/app/${org.id}/settings`;
  return (
    <>
      <PageHeader
        title="Settings"
        description="Your business details, delivery charges and what prints on invoices."
      />
      <TabNav
        tabs={[
          { href: base, label: 'Business', exact: true },
          { href: `${base}/selling`, label: 'Selling and delivery' },
        ]}
      />
      {children}
    </>
  );
}
