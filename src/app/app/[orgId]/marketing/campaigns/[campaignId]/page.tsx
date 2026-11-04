'use client';

import { useParams } from 'next/navigation';
import { BackLink } from '@/components/campaigns/back-link';
import { CampaignEditor } from '@/components/campaigns/campaign-editor';
import { CampaignReport } from '@/components/campaigns/campaign-report';
import { useCampaign, useCampaignOptions } from '@/components/campaigns/data';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { CAMPAIGN_STATUS } from '@/lib/campaigns';

/** A draft or scheduled campaign opens in the editor; one that started shows its report. */
export default function CampaignPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const { org, can } = useOrg();
  const editable = can('marketing.manage');
  const campaign = useCampaign(org.id, campaignId);
  const options = useCampaignOptions(org.id);
  const back = <BackLink href={`/app/${org.id}/marketing/campaigns`}>Campaigns</BackLink>;

  if (campaign.isPending || options.isPending)
    return (
      <>
        {back}
        <Skeleton className="h-96" />
      </>
    );
  if (campaign.isError || options.isError)
    return (
      <>
        {back}
        <PageError
          error={campaign.error ?? options.error}
          onRetry={() => {
            void campaign.refetch();
            void options.refetch();
          }}
        />
      </>
    );

  const c = campaign.data;
  const st = CAMPAIGN_STATUS[c.status];
  const inEditor = c.status === 'draft' || c.status === 'scheduled';
  return (
    <>
      {back}
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.name} <Badge tone={st.tone}>{st.label}</Badge>
          </span>
        }
      />
      {inEditor ? (
        // A new key when the campaign starts or is saved elsewhere resets the editor's draft.
        <CampaignEditor
          key={`${c.id}:${c.status}`}
          campaign={c}
          options={options.data}
          editable={editable}
        />
      ) : (
        <CampaignReport campaign={c} options={options.data} editable={editable} />
      )}
    </>
  );
}
