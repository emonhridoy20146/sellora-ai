'use client';

import { Lock, Megaphone } from 'lucide-react';
import Link from 'next/link';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * Marketing (campaigns, automations, abandoned carts) needs a role with marketing and a plan
 * with the marketing module. The API checks both again on every call.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  const { org, can, modules } = useOrg();
  const visible = can('marketing.manage') || can('marketing.view');
  const inPlan = modules === null || modules.includes('marketing');
  if (!visible)
    return (
      <EmptyState icon={Megaphone} title="Your role does not include marketing">
        Ask the business owner to give your role access to marketing.
      </EmptyState>
    );
  if (!inPlan)
    return (
      <EmptyState
        icon={Lock}
        title="SMS marketing is not in your plan"
        action={
          can('billing.view') && (
            <Button asChild>
              <Link href={`/app/${org.id}/billing/plans`}>See plans</Link>
            </Button>
          )
        }
      >
        Upgrade to text your customers: campaigns to the groups you choose, a thank-you after
        delivery, a nudge for customers who stopped ordering, and abandoned cart reminders.
      </EmptyState>
    );
  return <>{children}</>;
}
