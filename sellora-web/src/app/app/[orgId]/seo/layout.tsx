'use client';

import { Lock, Search } from 'lucide-react';
import Link from 'next/link';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { TabNav } from '@/components/ui/tab-nav';

/**
 * The AI SEO studio and content studio (ADR 0032) need a role with marketing and a plan with
 * the SEO module. The API checks both again on every call.
 */
export default function SeoLayout({ children }: { children: React.ReactNode }) {
  const { org, can, modules } = useOrg();
  const visible = can('marketing.manage') || can('marketing.view');
  const inPlan = modules === null || modules.includes('seo');
  const base = `/app/${org.id}/seo`;
  if (!visible)
    return (
      <EmptyState icon={Search} title="Your role does not include the SEO studio">
        Ask the business owner to give your role access to marketing.
      </EmptyState>
    );
  if (!inPlan)
    return (
      <EmptyState
        icon={Lock}
        title="The AI SEO studio is not in your plan"
        action={
          can('billing.view') && (
            <Button asChild>
              <Link href={`/app/${org.id}/billing/plans`}>See plans</Link>
            </Button>
          )
        }
      >
        Upgrade to find the keywords shoppers type, let AI write search titles, descriptions and
        questions for your products, see your Google clicks, and write ad copy and captions.
      </EmptyState>
    );
  return (
    <div>
      <PageHeader
        title="SEO studio"
        description="Get found on Google: keywords, product pages that rank, and your Search Console numbers."
      />
      <TabNav
        tabs={[
          { href: base, label: 'Overview', exact: true },
          { href: `${base}/keywords`, label: 'Keywords' },
          { href: `${base}/search-console`, label: 'Search Console' },
          { href: `${base}/content`, label: 'Content studio' },
        ]}
      />
      {children}
    </div>
  );
}
