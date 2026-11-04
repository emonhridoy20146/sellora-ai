'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { AUTOMATION_COPY, AutomationCard } from '@/components/campaigns/automation-card';
import {
  useAutomationSends,
  useAutomations,
  useAutomationsPatch,
  useCampaignOptions,
} from '@/components/campaigns/data';
import { MarketingHeader } from '@/components/campaigns/marketing-header';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadMore } from '@/components/ui/load-more';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { errorMessage } from '@/lib/api/errors';
import type { AutomationKind, Locale } from '@/lib/api/types';
import { AUTOMATION_SKIP } from '@/lib/campaigns';
import { hourLabel } from '@/lib/carts';
import { formatDateTime, formatMoney } from '@/lib/format';
import { localPhone, STATUS_LABEL } from '@/lib/sms';

const KINDS: AutomationKind[] = ['after_delivery', 'win_back'];

/**
 * Marketing › Automations: the thank-you after delivery and the win-back text, each with its
 * switch, timing, link and text, then every planned and sent text.
 */
export default function AutomationsPage() {
  const { org, can } = useOrg();
  const editable = can('marketing.manage');
  const settings = useAutomations(org.id);
  const options = useCampaignOptions(org.id);
  const language = useAutomationsPatch(org.id);

  const setLanguage = (l: Locale) =>
    language.mutate(
      { language: l },
      {
        onSuccess: () =>
          toast.success(
            l === 'bn'
              ? 'Default texts are in Bangla now. Texts you wrote yourself stay as they are.'
              : 'Default texts are in English now. Texts you wrote yourself stay as they are.',
          ),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  return (
    <>
      <MarketingHeader />
      {settings.isPending || options.isPending ? (
        <Skeleton className="h-96" />
      ) : settings.isError || options.isError ? (
        <PageError
          error={settings.error ?? options.error}
          onRetry={() => {
            void settings.refetch();
            void options.refetch();
          }}
        />
      ) : (
        <div className="grid gap-6">
          {!settings.data.sms.ready && (
            <Alert
              tone="warning"
              title="SMS is not ready"
              action={
                can('org.integrations.manage') && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/app/${org.id}/settings/sms`}>Settings › SMS</Link>
                  </Button>
                )
              }
            >
              {settings.data.sms.message} Planned texts wait until SMS works and are skipped once
              they are more than {settings.data.maxLateDays} days late.
            </Alert>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-[13px] text-muted-foreground">
              Texts go out between {hourLabel(settings.data.sendWindow.startHour)} and{' '}
              {hourLabel(settings.data.sendWindow.endHour)} ({options.data.timezone}). A customer
              gets at most one automation text in {settings.data.gapHours} hours, and numbers that
              asked to stop get none.
            </p>
            {editable && (
              <Segmented
                label="Language of the default texts"
                value={settings.data.language}
                onChange={(l) => l !== settings.data.language && setLanguage(l)}
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'bn', label: 'বাংলা' },
                ]}
              />
            )}
          </div>
          {KINDS.map((kind) => {
            const a = settings.data[kind];
            return (
              <AutomationCard
                // A new saved version (here or by a language switch) resets the card's draft.
                key={`${kind}:${a.days}:${a.text}:${a.link.kind}:${a.link.targetId ?? ''}:${a.link.storeId ?? ''}`}
                kind={kind}
                settings={settings.data}
                options={options.data}
                editable={editable}
              />
            );
          })}
          <SendsCard tz={options.data.timezone} />
        </div>
      )}
    </>
  );
}

const SEND_VIEWS = [
  { value: 'all', label: 'Both' },
  { value: 'after_delivery', label: 'After delivery' },
  { value: 'win_back', label: 'Win back' },
] as const;

function SendsCard({ tz }: { tz: string }) {
  const { org, can } = useOrg();
  const [kind, setKind] = useState<AutomationKind | 'all'>('all');
  const list = useAutomationSends(org.id, kind);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>Texts planned and sent</CardTitle>
        <Segmented
          label="Show texts of"
          value={kind}
          onChange={setKind}
          options={SEND_VIEWS.map((v) => ({ value: v.value, label: v.label }))}
        />
      </CardHeader>
      <CardContent className="px-0 py-0">
        {list.isPending ? (
          <Skeleton className="m-4 h-32" />
        ) : list.isError ? (
          <p className="p-6 text-sm text-destructive">{errorMessage(list.error)}</p>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Nothing yet. Texts are planned once an automation is on.
          </p>
        ) : (
          <Table data-testid="automation-sends">
            <THead>
              <TR>
                <TH>Customer</TH>
                <TH>Automation</TH>
                <TH>Text</TH>
                <TH>Order after</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((s) => {
                const st = s.message ? STATUS_LABEL[s.message.status] : null;
                return (
                  <TR key={s.id}>
                    <TD>
                      {s.customerId && can('customers.view') ? (
                        <Link
                          href={`/app/${org.id}/customers/${s.customerId}`}
                          className="font-medium hover:underline"
                        >
                          {s.name || localPhone(s.phone)}
                        </Link>
                      ) : (
                        <span className="font-medium">{s.name || localPhone(s.phone)}</span>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {localPhone(s.phone)}
                      </span>
                    </TD>
                    <TD className="text-sm">
                      {AUTOMATION_COPY[s.kind].title}
                      {s.orderNumber && (
                        <span className="block text-xs text-muted-foreground">
                          Order{' '}
                          {s.orderId && can('orders.view') ? (
                            <Link
                              href={`/app/${org.id}/orders/${s.orderId}`}
                              className="text-primary hover:underline"
                            >
                              {s.orderNumber}
                            </Link>
                          ) : (
                            s.orderNumber
                          )}
                        </span>
                      )}
                    </TD>
                    <TD>
                      {s.status === 'pending' ? (
                        <span className="grid gap-0.5 text-sm">
                          <span>
                            <Badge tone="neutral">Planned</Badge>
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatDateTime(s.dueAt, tz)}
                          </span>
                        </span>
                      ) : s.status === 'skipped' ? (
                        <span className="text-sm text-muted-foreground">
                          Skipped: {s.skip ? AUTOMATION_SKIP[s.skip] : 'not sent'}
                        </span>
                      ) : (
                        <span className="grid gap-0.5">
                          <span>{st ? <Badge tone={st.tone}>{st.label}</Badge> : 'Sent'}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatDateTime(s.sentAt, tz)}
                            {s.message?.error && ` · ${s.message.error}`}
                          </span>
                        </span>
                      )}
                    </TD>
                    <TD>
                      {s.order ? (
                        <span className="grid gap-0.5">
                          {can('orders.view') ? (
                            <Link
                              href={`/app/${org.id}/orders/${s.order.id}`}
                              className="font-medium text-primary hover:underline"
                            >
                              {s.order.number}
                            </Link>
                          ) : (
                            <span className="font-medium">{s.order.number}</span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {formatMoney(s.order.totalMinor, org.currency)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
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
  );
}
