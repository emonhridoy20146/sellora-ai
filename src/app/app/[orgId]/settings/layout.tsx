'use client';

import { useOrg } from '@/components/org-context';
import { PageHeader } from '@/components/ui/page-header';
import { TabNav } from '@/components/ui/tab-nav';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { org, can } = useOrg();
  const base = `/app/${org.id}/settings`;
  return (
    <>
      <PageHeader
        title="Settings"
        description="Your business details, delivery charges, invoices, chat channels, payments, couriers, ad tracking, SMS and backups."
      />
      <TabNav
        tabs={[
          { href: base, label: 'Business', exact: true },
          { href: `${base}/selling`, label: 'Selling and delivery' },
          ...(can('org.integrations.manage')
            ? [
                { href: `${base}/channels`, label: 'Channels' },
                { href: `${base}/payments`, label: 'Payments' },
                { href: `${base}/couriers`, label: 'Couriers' },
                { href: `${base}/ad-tracking`, label: 'Ad tracking' },
              ]
            : []),
          ...(can('org.integrations.manage') || can('billing.view')
            ? [{ href: `${base}/sms`, label: 'SMS' }]
            : []),
          ...(can('org.backups.manage') ? [{ href: `${base}/backups`, label: 'Backups' }] : []),
        ]}
      />
      {children}
    </>
  );
}
