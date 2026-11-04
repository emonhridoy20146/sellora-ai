'use client';

import { BackLink } from '@/components/campaigns/back-link';
import { CampaignEditor } from '@/components/campaigns/campaign-editor';
import { useCampaignOptions } from '@/components/campaigns/data';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';

/** A new campaign: nothing is saved until "Save draft", a test or "Send". */
export default function NewCampaignPage() {
  const { org, can } = useOrg();
  const editable = can('marketing.manage');
  const options = useCampaignOptions(org.id, editable);
  const back = `/app/${org.id}/marketing/campaigns`;

  if (!editable)
    return (
      <EmptyState title="Your role cannot make campaigns">
        Ask the business owner for the marketing manager permission.
      </EmptyState>
    );
  return (
    <>
      <BackLink href={back}>Campaigns</BackLink>
      <PageHeader
        title="New campaign"
        description="One text to a group of your customers. Nothing is sent until you press Send now or Schedule."
      />
      {options.isPending ? (
        <Skeleton className="h-96" />
      ) : options.isError ? (
        <PageError error={options.error} onRetry={() => void options.refetch()} />
      ) : (
        <CampaignEditor options={options.data} editable />
      )}
    </>
  );
}
