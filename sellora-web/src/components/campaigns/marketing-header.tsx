'use client';

import { useOrg } from '@/components/org-context';
import { PageHeader } from '@/components/ui/page-header';
import { TabNav } from '@/components/ui/tab-nav';

/** The Marketing title and its three tabs. */
export function MarketingHeader({ actions }: { actions?: React.ReactNode }) {
  const { org } = useOrg();
  const base = `/app/${org.id}/marketing`;
  return (
    <>
      <PageHeader
        title="Marketing"
        description="Texts that bring customers back: campaigns you send, automatic follow-ups, and reminders for carts left behind. Each text ends with a link to stop them."
        actions={actions}
      />
      <TabNav
        tabs={[
          { href: `${base}/campaigns`, label: 'Campaigns' },
          { href: `${base}/automations`, label: 'Automations' },
          { href: `${base}/carts`, label: 'Abandoned carts' },
        ]}
      />
    </>
  );
}
