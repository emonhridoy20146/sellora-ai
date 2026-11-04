'use client';

import { Megaphone, Plus, Send, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useCampaignOptions, useCampaigns } from '@/components/campaigns/data';
import { MarketingHeader } from '@/components/campaigns/marketing-header';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LoadMore } from '@/components/ui/load-more';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import type { CampaignSummary } from '@/lib/api/types';
import { CAMPAIGN_STATUS, CAMPAIGN_VIEWS, type CampaignView } from '@/lib/campaigns';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';

const VIEW_LABEL: Record<CampaignView, string> = {
  all: 'All',
  draft: 'Drafts',
  scheduled: 'Scheduled',
  sending: 'Sending',
  paused: 'Paused',
  sent: 'Sent',
};

const STEPS = [
  {
    icon: Users,
    title: 'Choose who gets it',
    text: 'Customers who ordered, spent, or stopped ordering, by tag or where they came from.',
  },
  {
    icon: Megaphone,
    title: 'Write the text',
    text: 'With their name, your shop and a short link to your store, a landing page or a product.',
  },
  {
    icon: Send,
    title: 'Send or schedule',
    text: 'Texts go out in daytime batches. Clicks and orders after the text are counted.',
  },
];

/** When the campaign happened or will happen, in the business's time zone. */
function whenOf(c: CampaignSummary, tz: string): string {
  if (c.status === 'draft') return `Edited ${formatDateTime(c.updatedAt, tz)}`;
  if (c.status === 'scheduled') return `Starts ${formatDateTime(c.scheduledAt, tz)}`;
  if (c.status === 'cancelled') return `Cancelled ${formatDateTime(c.updatedAt, tz)}`;
  if (c.finishedAt) return `Sent ${formatDateTime(c.finishedAt, tz)}`;
  return `Started ${formatDateTime(c.startedAt, tz)}`;
}

/** Marketing › Campaigns: every campaign, newest first, with what it brought back. */
export default function CampaignsPage() {
  const { org, can } = useOrg();
  const editable = can('marketing.manage');
  const [view, setView] = useState<CampaignView>('all');
  const list = useCampaigns(org.id, view);
  const options = useCampaignOptions(org.id);
  const tz = options.data?.timezone ?? org.timezone;
  const base = `/app/${org.id}/marketing/campaigns`;
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  const createButton = editable && (
    <Button asChild>
      <Link href={`${base}/new`}>
        <Plus /> New campaign
      </Link>
    </Button>
  );
  const empty = !list.isPending && !list.isError && items.length === 0;

  return (
    <>
      <MarketingHeader actions={!(empty && view === 'all') ? createButton : undefined} />
      {list.isPending ? (
        <Skeleton className="h-48" />
      ) : list.isError ? (
        <PageError error={list.error} onRetry={() => void list.refetch()} />
      ) : empty && view === 'all' ? (
        <Card>
          <CardContent className="grid gap-6 py-8">
            <div className="text-center">
              <h2 className="text-lg font-semibold">Text your customers an offer</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                A campaign is one SMS to a group of your customers. Numbers that asked to stop never
                get it.
              </p>
            </div>
            <ol className="grid gap-4 sm:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="rounded-lg border p-4">
                  <s.icon className="mb-2 size-5 text-primary" aria-hidden />
                  <p className="font-medium">
                    {i + 1}. {s.title}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
                </li>
              ))}
            </ol>
            <div className="flex justify-center">
              {createButton || (
                <p className="text-sm text-muted-foreground">
                  Ask a marketing manager to make a campaign.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          <Segmented
            label="Show campaigns"
            value={view}
            onChange={setView}
            options={CAMPAIGN_VIEWS.map((v) => ({ value: v, label: VIEW_LABEL[v] }))}
          />
          <Card>
            <CardContent className="px-0 py-0">
              {items.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  No {VIEW_LABEL[view].toLowerCase()} campaigns.
                </p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Campaign</TH>
                      <TH>Status</TH>
                      <TH className="text-right">Customers</TH>
                      <TH className="text-right">Texts</TH>
                      <TH className="text-right">Orders after</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {items.map((c) => {
                      const st = CAMPAIGN_STATUS[c.status];
                      const planned = c.counts.recipients || c.estimate?.recipients || 0;
                      return (
                        <TR key={c.id}>
                          <TD className="max-w-96">
                            <Link
                              href={`${base}/${c.id}`}
                              className="font-medium text-primary hover:underline"
                            >
                              {c.name}
                            </Link>
                            <span className="block truncate text-xs text-muted-foreground">
                              {whenOf(c, tz)}
                            </span>
                          </TD>
                          <TD>
                            <Badge tone={st.tone}>{st.label}</Badge>
                          </TD>
                          <TD className="text-right tabular-nums">
                            {c.status === 'draft' ? '—' : formatNumber(planned)}
                          </TD>
                          <TD className="text-right tabular-nums">
                            {c.status === 'draft' || c.status === 'scheduled'
                              ? '—'
                              : formatNumber(c.counts.queued)}
                          </TD>
                          <TD className="text-right tabular-nums">
                            {c.orders.count > 0 ? (
                              <>
                                {formatNumber(c.orders.count)}
                                <span className="block text-xs text-muted-foreground">
                                  {formatMoney(c.orders.revenueMinor, org.currency)}
                                </span>
                              </>
                            ) : (
                              '—'
                            )}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              )}
              <LoadMore
                hasMore={Boolean(list.hasNextPage)}
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              />
            </CardContent>
          </Card>
          <p className="text-[13px] text-muted-foreground">
            Orders after: orders a recipient placed within 7 days of getting the text.
          </p>
        </div>
      )}
    </>
  );
}
