'use client';

import { BarChart3, MessagesSquare, Package } from 'lucide-react';
import { useState } from 'react';
import { useAnalytics, ValueTiles } from '@/components/analytics/value-tiles';
import { ColumnChart } from '@/components/charts/column-chart';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { replyDays, replyTime, salesDays, share } from '@/lib/analytics';
import type { AnalyticsOverview } from '@/lib/api/types';
import { ORDER_SOURCE_LABEL } from '@/lib/commerce';
import { formatMoney, formatNumber, minorDigits } from '@/lib/format';
import { CHANNEL_LABEL } from '@/lib/inbox';
import { longDay, shortDay } from '@/lib/series';
import { cn } from '@/lib/utils';

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const;

export default function AnalyticsPage() {
  const { org } = useOrg();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const q = useAnalytics(org.id, Number(days));
  const o = q.data;

  return (
    <>
      <PageHeader
        title="Analytics"
        description="What Sellora did for your business, and how sales and chats went."
        actions={<Segmented label="Period" value={days} onChange={setDays} options={[...RANGES]} />}
      />
      {q.isError ? (
        <PageError error={q.error} onRetry={() => void q.refetch()} />
      ) : !o ? (
        <div className="grid gap-6">
          <Skeleton className="h-32" />
          <Skeleton className="h-72" />
        </div>
      ) : (
        <div className={cn('grid gap-8 transition-opacity', q.isPlaceholderData && 'opacity-60')}>
          <ValueSection o={o} days={Number(days)} />
          {o.sales && <SalesSection o={o} />}
          {o.inbox && <ChatsSection o={o} />}
          <p className="text-[13px] text-muted-foreground">
            Days follow {o.range.timezone.replaceAll('_', ' ')} time. Sales leave out cancelled and
            returned orders.
          </p>
        </div>
      )}
    </>
  );
}

function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mb-3 text-base font-semibold">
      {children}
    </h2>
  );
}

function ValueSection({ o, days }: { o: AnalyticsOverview; days: number }) {
  const tiles = <ValueTiles o={o} />;
  return (
    <section aria-labelledby="value-heading">
      <SectionTitle id="value-heading">
        What Sellora did for you in the last {days} days
      </SectionTitle>
      {o.value.ai || o.value.carts || o.value.riskyOrders ? (
        tiles
      ) : (
        <Card>
          <EmptyState icon={BarChart3} title="Nothing to show yet">
            The AI sales agent, abandoned cart reminders and the fraud check show their results here
            when your plan includes them.
          </EmptyState>
        </Card>
      )}
    </section>
  );
}

function SalesSection({ o }: { o: AnalyticsOverview }) {
  const s = o.sales!;
  const money = (minor: number) => formatMoney(minor, o.range.currency);
  const days = salesDays(o);
  const aiShown = o.value.ai !== null;
  return (
    <section aria-labelledby="sales-heading" className="grid gap-4">
      <SectionTitle id="sales-heading">Sales</SectionTitle>
      <div className="-mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sales" value={money(s.valueMinor)} sub={`${formatNumber(s.orders)} orders`} />
        <Stat label="Average order" value={s.orders ? money(s.averageMinor) : '–'} />
        <Stat
          label="Delivered"
          value={formatNumber(s.delivered)}
          sub="Of the orders placed in this period"
        />
        <Stat
          label="Cancelled or returned"
          value={formatNumber(s.cancelled + s.returned)}
          sub={`${formatNumber(s.cancelled)} cancelled, ${formatNumber(s.returned)} returned`}
        />
      </div>
      {s.orders === 0 ? (
        <Card>
          <EmptyState icon={Package} title="No orders in this period" />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Orders per day</CardTitle>
                {aiShown && (
                  <CardDescription>Taken by the AI, and all other orders.</CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <ColumnChart
                  label="Day"
                  data={days.map((d) => ({
                    key: d.key,
                    values: aiShown ? [d.aiOrders, d.otherOrders] : [d.aiOrders + d.otherOrders],
                  }))}
                  series={
                    aiShown
                      ? [
                          { name: 'Taken by the AI', color: '--series-1' },
                          { name: 'Other orders', color: '--series-2' },
                        ]
                      : [{ name: 'Orders', color: '--series-1' }]
                  }
                  formatValue={(n) => formatNumber(n)}
                  formatKey={shortDay}
                  formatKeyLong={longDay}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Sales per day</CardTitle>
              </CardHeader>
              <CardContent>
                <ColumnChart
                  label="Day"
                  data={days.map((d) => ({ key: d.key, values: [d.valueMinor] }))}
                  series={[{ name: 'Sales', color: '--series-1' }]}
                  formatValue={money}
                  formatTick={(n) =>
                    formatNumber(n / 10 ** minorDigits(o.range.currency), { compact: true })
                  }
                  formatKey={shortDay}
                  formatKeyLong={longDay}
                />
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Where orders came from</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <Table>
                  <THead>
                    <TR>
                      <TH>Source</TH>
                      <TH className="text-right">Orders</TH>
                      <TH className="text-right">Sales</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {s.bySource.map((r) => (
                      <TR key={r.source}>
                        <TD>{ORDER_SOURCE_LABEL[r.source] ?? r.source}</TD>
                        <TD className="tabular text-right">{formatNumber(r.orders)}</TD>
                        <TD className="tabular text-right">{money(r.valueMinor)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Best sellers</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <Table>
                  <THead>
                    <TR>
                      <TH>Product</TH>
                      <TH className="text-right">Sold</TH>
                      <TH className="text-right">Sales</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {s.topProducts.map((p) => (
                      <TR key={p.productId}>
                        <TD className="max-w-56 truncate" title={p.name}>
                          {p.name}
                        </TD>
                        <TD className="tabular text-right">{formatNumber(p.quantity)}</TD>
                        <TD className="tabular text-right">{money(p.valueMinor)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </section>
  );
}

function ChatsSection({ o }: { o: AnalyticsOverview }) {
  const c = o.inbox!;
  const days = replyDays(o);
  const replies = c.aiReplies + c.teamReplies;
  const aiShown = o.value.ai !== null;
  return (
    <section aria-labelledby="chats-heading" className="grid gap-4">
      <SectionTitle id="chats-heading">Chats</SectionTitle>
      <div className="-mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Chats with customers"
          value={formatNumber(c.conversations)}
          sub={`${formatNumber(c.customerMessages)} customer messages`}
        />
        {aiShown && (
          <Stat
            label="AI reply time"
            value={replyTime(c.replySeconds.ai)}
            sub="Typical time to answer a customer"
          />
        )}
        <Stat
          label="Team reply time"
          value={replyTime(c.replySeconds.team)}
          sub="Typical time to answer a customer"
        />
        {aiShown && (
          <Stat
            label="Replies by the AI"
            value={share(c.aiReplies, replies) === null ? '–' : `${share(c.aiReplies, replies)}%`}
            sub={`${formatNumber(c.aiReplies)} of ${formatNumber(replies)} replies`}
          />
        )}
      </div>
      {c.conversations === 0 ? (
        <Card>
          <EmptyState icon={MessagesSquare} title="No customer messages in this period" />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Replies per day</CardTitle>
              {aiShown && (
                <CardDescription>By the AI sales agent and by your team.</CardDescription>
              )}
            </CardHeader>
            <CardContent>
              <ColumnChart
                label="Day"
                data={days.map((d) => ({
                  key: d.key,
                  values: aiShown ? [d.aiReplies, d.teamReplies] : [d.teamReplies],
                }))}
                series={
                  aiShown
                    ? [
                        { name: 'By the AI', color: '--series-1' },
                        { name: 'By your team', color: '--series-2' },
                      ]
                    : [{ name: 'By your team', color: '--series-1' }]
                }
                formatValue={(n) => formatNumber(n)}
                formatKey={shortDay}
                formatKeyLong={longDay}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Chats by channel</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Channel</TH>
                    <TH className="text-right">Chats</TH>
                  </TR>
                </THead>
                <TBody>
                  {c.byChannel.map((r) => (
                    <TR key={r.channelType}>
                      <TD>{CHANNEL_LABEL[r.channelType]}</TD>
                      <TD className="tabular text-right">{formatNumber(r.conversations)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}
