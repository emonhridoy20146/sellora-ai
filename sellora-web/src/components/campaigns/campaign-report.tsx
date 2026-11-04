'use client';

import { Copy, Pause, Play, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LoadMore } from '@/components/ui/load-more';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { errorMessage } from '@/lib/api/errors';
import type { Campaign, CampaignOptions } from '@/lib/api/types';
import {
  audienceSummary,
  PAUSE_TEXT,
  RECIPIENT_SKIP,
  sentOf,
  waitingOf,
  waitText,
} from '@/lib/campaigns';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { localPhone, STATUS_LABEL } from '@/lib/sms';
import { useCampaignAction, useRecipients } from './data';

const RECIPIENT_VIEWS = [
  { value: 'all', label: 'Everyone' },
  { value: 'queued', label: 'Texted' },
  { value: 'ordered', label: 'Ordered' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'pending', label: 'Not yet' },
] as const;
type RecipientView = (typeof RECIPIENT_VIEWS)[number]['value'];

/**
 * A campaign that started: how far it got, why it waits or paused, what it cost and brought
 * back, the controls (pause, resume, cancel, duplicate) and every recipient.
 */
export function CampaignReport({
  campaign: c,
  options,
  editable,
}: {
  campaign: Campaign;
  options: CampaignOptions;
  editable: boolean;
}) {
  const { org, can } = useOrg();
  const router = useRouter();
  const action = useCampaignAction(org.id);
  const [confirm, setConfirm] = useState<null | 'cancel'>(null);
  const tz = options.timezone;
  const currency = options.currency;
  const sent = sentOf(c.messages.byStatus);
  const waiting = waitingOf(c.messages.byStatus);
  const failed = (c.messages.byStatus.failed ?? 0) + (c.messages.byStatus.unknown ?? 0);
  const running = c.status === 'sending' || c.status === 'paused';

  const run = (name: 'pause' | 'resume' | 'cancel' | 'duplicate', done: (next: Campaign) => void) =>
    action.mutateAsync({ id: c.id, action: name }).then(done, (err: unknown) => {
      toast.error(errorMessage(err));
      throw err;
    });

  const pause = () =>
    void run('pause', () =>
      toast.success('Paused. Nobody else gets the text until you resume.'),
    ).catch(() => undefined);
  const resume = () =>
    void run('resume', () => toast.success('Resumed. The rest go out in batches.')).catch(
      () => undefined,
    );
  const duplicate = () =>
    void run('duplicate', (copy) => {
      toast.success('Copied as a new draft.');
      router.push(`/app/${org.id}/marketing/campaigns/${copy.id}`);
    }).catch(() => undefined);
  const cancel = () => run('cancel', () => toast.success('Cancelled. Nobody else gets the text.'));

  const pauseText = c.pause ? PAUSE_TEXT[c.pause.reason] : null;
  const handled = c.counts.queued + c.counts.optedOut + c.counts.unreachable;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {c.startedAt && `Started ${formatDateTime(c.startedAt, tz)}`}
          {c.finishedAt && ` · finished ${formatDateTime(c.finishedAt, tz)}`}
          {c.cancelledAt && ` · cancelled ${formatDateTime(c.cancelledAt, tz)}`}
        </p>
        {editable && (
          <div className="flex flex-wrap gap-2">
            {c.status === 'sending' && (
              <Button variant="outline" onClick={pause} loading={action.isPending}>
                <Pause aria-hidden /> Pause
              </Button>
            )}
            {c.status === 'paused' && (
              <Button onClick={resume} loading={action.isPending}>
                <Play aria-hidden /> Resume
              </Button>
            )}
            {running && (
              <Button variant="outline" onClick={() => setConfirm('cancel')}>
                <XCircle aria-hidden /> Cancel
              </Button>
            )}
            <Button variant="outline" onClick={duplicate} disabled={action.isPending}>
              <Copy aria-hidden /> Duplicate
            </Button>
          </div>
        )}
      </div>

      {c.status === 'paused' && pauseText && (
        <Alert
          tone="warning"
          title={pauseText.title}
          action={
            c.pause?.reason === 'wallet' && can('billing.view') ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/app/${org.id}/billing/wallet`}>Top up</Link>
              </Button>
            ) : c.pause?.reason === 'sms_off' && can('org.integrations.manage') ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/app/${org.id}/settings/sms`}>Settings › SMS</Link>
              </Button>
            ) : undefined
          }
        >
          {pauseText.text}
        </Alert>
      )}
      {c.status === 'sending' && c.wait && (
        <Alert tone="info" title="Waiting">
          {waitText(c.wait, tz, options.sendWindow)}
        </Alert>
      )}

      {running && (
        <div className="grid gap-1.5" data-testid="campaign-progress">
          <div className="flex justify-between text-sm">
            <span>
              {formatNumber(handled)} of {formatNumber(c.counts.recipients)} customers handled
            </span>
            <span className="text-muted-foreground">{Math.round(c.progress * 100)}%</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Campaign progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(c.progress * 100)}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${Math.round(c.progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5" data-testid="campaign-stats">
        <Stat
          label="Customers"
          value={formatNumber(c.counts.recipients)}
          sub={
            [
              c.counts.optedOut > 0 && `${formatNumber(c.counts.optedOut)} asked to stop`,
              c.counts.unreachable > 0 && `${formatNumber(c.counts.unreachable)} unreachable`,
            ]
              .filter(Boolean)
              .join(' · ') || 'Everyone was reachable'
          }
        />
        <Stat
          label="Texts sent"
          value={formatNumber(sent)}
          sub={
            [
              waiting > 0 && `${formatNumber(waiting)} on the way`,
              failed > 0 && `${formatNumber(failed)} failed`,
              c.messages.byStatus.delivered > 0 &&
                `${formatNumber(c.messages.byStatus.delivered)} delivered`,
            ]
              .filter(Boolean)
              .join(' · ') || undefined
          }
        />
        <Stat
          label="Link clicks"
          value={c.link.kind === 'none' ? '—' : formatNumber(c.link.clicks)}
          sub={c.link.kind === 'none' ? 'No link in the text' : (c.link.label ?? undefined)}
        />
        <Stat
          label="Orders after"
          value={formatNumber(c.orders.count)}
          sub={`${formatMoney(c.orders.revenueMinor, currency)} within 7 days`}
        />
        <Stat
          label="SMS cost"
          value={formatMoney(c.messages.spentMinor, c.estimate?.currency ?? currency)}
          sub={c.stopped > 0 ? `${formatNumber(c.stopped)} pressed stop after it` : undefined}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>The text</CardTitle>
          <CardDescription>{audienceSummary(c.audience, currency)}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div
            className="max-w-md rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-sm break-words whitespace-pre-wrap"
            data-testid="campaign-sent-text"
          >
            {c.preview.text}
          </div>
          <p className="text-[13px] text-muted-foreground">
            As a sample customer got it. {c.preview.parts} SMS part
            {c.preview.parts === 1 ? '' : 's'}.
            {c.link.url && (
              <>
                {' '}
                Short link:{' '}
                <a
                  href={c.link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary underline"
                >
                  {c.link.url.replace(/^https?:\/\//, '')}
                </a>
                {c.link.label && ` → ${c.link.label}`}
              </>
            )}
          </p>
        </CardContent>
      </Card>

      <RecipientsCard campaignId={c.id} tz={tz} />

      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Cancel this campaign?"
        description="Customers who already got the text keep it; nobody else gets it. To send it again later, duplicate it."
        confirmLabel="Cancel campaign"
        destructive
        onConfirm={cancel}
      />
    </div>
  );
}

function RecipientsCard({ campaignId, tz }: { campaignId: string; tz: string }) {
  const { org, can } = useOrg();
  const [view, setView] = useState<RecipientView>('all');
  const list = useRecipients(org.id, campaignId, view);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const canOrders = can('orders.view');
  const canCustomers = can('customers.view');

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>Recipients</CardTitle>
        <Segmented
          label="Show recipients"
          value={view}
          onChange={setView}
          options={RECIPIENT_VIEWS.map((v) => ({ value: v.value, label: v.label }))}
        />
      </CardHeader>
      <CardContent className="px-0 py-0">
        {list.isPending ? (
          <Skeleton className="m-4 h-32" />
        ) : list.isError ? (
          <p className="p-6 text-sm text-destructive">{errorMessage(list.error)}</p>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Nobody here.</p>
        ) : (
          <Table data-testid="campaign-recipients">
            <THead>
              <TR>
                <TH>Customer</TH>
                <TH>Text</TH>
                <TH>Order after</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((r) => {
                const st = r.message ? STATUS_LABEL[r.message.status] : null;
                return (
                  <TR key={r.id}>
                    <TD>
                      {canCustomers ? (
                        <Link
                          href={`/app/${org.id}/customers/${r.customerId}`}
                          className="font-medium hover:underline"
                        >
                          {r.name || localPhone(r.phone)}
                        </Link>
                      ) : (
                        <span className="font-medium">{r.name || localPhone(r.phone)}</span>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {localPhone(r.phone)}
                      </span>
                    </TD>
                    <TD>
                      {r.status === 'skipped' ? (
                        <span className="text-sm text-muted-foreground">
                          Skipped: {r.skip ? RECIPIENT_SKIP[r.skip] : 'not sent'}
                        </span>
                      ) : r.status === 'pending' ? (
                        <span className="text-sm text-muted-foreground">Not yet</span>
                      ) : st ? (
                        <span className="grid gap-0.5">
                          <span>
                            <Badge tone={st.tone}>{st.label}</Badge>
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatDateTime(r.queuedAt, tz)}
                            {r.message?.error && ` · ${r.message.error}`}
                          </span>
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">Queued</span>
                      )}
                    </TD>
                    <TD>
                      {r.order ? (
                        <span className="grid gap-0.5">
                          {canOrders ? (
                            <Link
                              href={`/app/${org.id}/orders/${r.order.id}`}
                              className="font-medium text-primary hover:underline"
                            >
                              {r.order.number}
                            </Link>
                          ) : (
                            <span className="font-medium">{r.order.number}</span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {formatMoney(r.order.totalMinor, org.currency)} ·{' '}
                            {formatDateTime(r.order.at, tz)}
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
