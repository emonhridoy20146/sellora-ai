'use client';

import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, CircleCheck, Loader2, Plug, Store } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ColumnChart } from '@/components/charts/column-chart';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { seoKeys, useSearchConsole } from '@/components/seo/hooks';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { NativeSelect } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { SearchConsoleConnection, SearchGrouped, SearchReport } from '@/lib/api/types';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { longDay, shortDay } from '@/lib/series';
import { ctrText, positionText, productHref, totalsTiles } from '@/lib/seo';

type Days = '7' | '28' | '90';
const OPPS_SHOWN = 8;

const RESULT: Record<string, { tone: 'success' | 'warning' | 'danger'; text: string }> = {
  connected: {
    tone: 'success',
    text: 'Google is connected. Sellora is adding the verification tag, checking your store and sending the sitemap.',
  },
  denied: { tone: 'warning', text: 'Google was not connected: the permission was not given.' },
  no_permission: {
    tone: 'danger',
    text: 'Google did not give every permission needed. Connect again and allow Search Console and site verification.',
  },
  expired: { tone: 'warning', text: 'The sign-in took too long. Connect again.' },
  failed: { tone: 'danger', text: 'Google could not be connected. Try again in a minute.' },
};

const STEPS: { key: SearchConsoleConnection['step']; label: string }[] = [
  { key: 'verify', label: 'Prove you own the store' },
  { key: 'add_site', label: 'Add it to Search Console' },
  { key: 'sitemap', label: 'Send the sitemap' },
  { key: 'done', label: 'Fetch the numbers' },
];

/**
 * Google Search Console (ADR 0032): connect a Google account for an open store, and Sellora
 * proves ownership with a meta tag, adds the site, sends the sitemap and fetches clicks and
 * impressions every day. Opportunities point at phrases worth working on.
 */
export default function SearchConsolePage() {
  const { org, can } = useOrg();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [days, setDays] = useState<Days>('28');
  const data = useSearchConsole(org.id, Number(days) as 7 | 28 | 90);
  const editable = can('marketing.manage');
  const [storeId, setStoreId] = useState('');
  const [busy, setBusy] = useState<'connect' | 'retry' | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  // Google's answer comes back on the address; keep the message, take it off the address.
  const [result] = useState(() => RESULT[params.get('google') ?? '']);
  useEffect(() => {
    if (params.get('google')) router.replace(pathname);
  }, [params, pathname, router]);

  if (data.isError) return <PageError error={data.error} onRetry={() => void data.refetch()} />;
  if (!data.data) return <Skeleton className="h-64" />;
  const { configured, connection, stores, report } = data.data;

  const connect = async () => {
    const id = storeId || stores[0]?.id;
    if (!id) return;
    setBusy('connect');
    try {
      const { url } = await api<{ url: string }>(`/orgs/${org.id}/seo/search-console/connect`, {
        body: { storeId: id },
      });
      window.location.assign(url);
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy('retry');
    try {
      await api(`/orgs/${org.id}/seo/search-console/retry`, { method: 'POST' });
      void queryClient.invalidateQueries({ queryKey: seoKeys.all(org.id) });
      toast.success('Trying again now.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-6">
      {result && <Alert tone={result.tone}>{result.text}</Alert>}

      {!configured && !connection ? (
        <EmptyState icon={Plug} title="Google sign-in is not set up on this server yet">
          The platform owner adds a Google OAuth client with the Search Console and Site
          Verification APIs. Until then this page stays empty.
        </EmptyState>
      ) : !connection || connection.status === 'revoked' ? (
        <Card>
          <CardHeader>
            <CardTitle>Connect Google Search Console</CardTitle>
            <CardDescription>
              See how often Google shows your store, which phrases bring visitors, and what to
              improve. Sellora adds the verification tag to your store, adds the site and sends the
              sitemap for you.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {connection?.status === 'revoked' && (
              <Alert tone="warning" title="Google access was removed">
                {connection.email} no longer lets Sellora read Search Console. Connect again to keep
                the numbers coming.
              </Alert>
            )}
            {stores.length === 0 ? (
              <EmptyState icon={Store} title="Open your store first">
                Google can only check a store shoppers can visit.{' '}
                <Link href={`/app/${org.id}/store`} className="text-primary hover:underline">
                  Online store
                </Link>
              </EmptyState>
            ) : editable ? (
              <div className="flex flex-wrap items-end gap-3">
                {stores.length > 1 && (
                  <Field label="Store" htmlFor="sc-store">
                    <NativeSelect
                      id="sc-store"
                      value={storeId || stores[0]!.id}
                      onChange={(e) => setStoreId(e.target.value)}
                    >
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.url})
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                )}
                <Button onClick={() => void connect()} loading={busy === 'connect'}>
                  Connect with Google
                </Button>
                {stores.length === 1 && (
                  <p className="text-[13px] text-muted-foreground">For {stores[0]!.url}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Ask someone who manages marketing to connect Google.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <ConnectionCard
          c={connection}
          editable={editable}
          busy={busy === 'retry'}
          onRetry={() => void retry()}
          onDisconnect={() => setDisconnecting(true)}
          timezone={org.timezone}
        />
      )}

      {report && report.ready && (
        <ReportView report={report} days={days} setDays={setDays} orgId={org.id} />
      )}
      {report &&
        !report.ready &&
        connection?.status === 'connected' &&
        connection.step === 'done' && (
          <EmptyState icon={BarChart3} title="Fetching your numbers">
            Google usually has data a few days after a site is added. This page fills in by itself.
          </EmptyState>
        )}

      <ConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title="Disconnect Google Search Console?"
        description="Sellora stops fetching numbers and deletes the ones it has. Your site stays in Search Console, and the verification tag stays on your store so you keep ownership."
        confirmLabel="Disconnect"
        destructive
        onConfirm={async () => {
          await api(`/orgs/${org.id}/seo/search-console`, { method: 'DELETE' });
          void queryClient.invalidateQueries({ queryKey: seoKeys.all(org.id) });
        }}
      />
    </div>
  );
}

function ConnectionCard({
  c,
  editable,
  busy,
  onRetry,
  onDisconnect,
  timezone,
}: {
  c: SearchConsoleConnection;
  editable: boolean;
  busy: boolean;
  onRetry: () => void;
  onDisconnect: () => void;
  timezone: string;
}) {
  const at = STEPS.findIndex((s) => s.key === c.step);
  const finished = c.step === 'done' && Boolean(c.lastSyncAt);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>
            Search Console{' '}
            <Badge tone={c.setupError ? 'danger' : finished ? 'success' : 'info'}>
              {c.setupError ? 'Needs attention' : finished ? 'Connected' : 'Setting up'}
            </Badge>
          </CardTitle>
          <CardDescription>
            {c.siteUrl} with {c.email}
            {c.connectedBy ? `, connected by ${c.connectedBy}` : ''}
          </CardDescription>
        </div>
        {editable && (
          <div className="flex gap-2">
            {(c.setupError || c.lastSyncError || finished) && (
              <Button size="sm" variant="outline" onClick={onRetry} loading={busy}>
                {finished && !c.setupError ? 'Fetch now' : 'Try again'}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <ol className="grid gap-2 sm:grid-cols-4" aria-label="Setup steps">
          {STEPS.map((s, i) => {
            const done = i < at || (s.key === 'done' && finished);
            const now = i === at && !done;
            return (
              <li key={s.key} className="flex items-center gap-2 text-sm">
                {done ? (
                  <CircleCheck className="size-4 text-success" aria-label="Done" />
                ) : now && !c.setupError ? (
                  <Loader2 className="size-4 animate-spin text-primary" aria-label="Working" />
                ) : (
                  <span
                    className="inline-block size-4 rounded-full border-2 border-muted-foreground/40"
                    aria-label={now ? 'Stuck' : 'Not yet'}
                  />
                )}
                <span className={done ? '' : 'text-muted-foreground'}>{s.label}</span>
              </li>
            );
          })}
        </ol>
        {c.setupError && <Alert tone="danger">{c.setupError}</Alert>}
        {c.lastSyncError && !c.setupError && (
          <Alert tone="warning">Last fetch failed: {c.lastSyncError}</Alert>
        )}
        <p className="text-[13px] text-muted-foreground">
          {c.sitemapSubmittedAt
            ? `Sitemap sent ${formatDate(c.sitemapSubmittedAt, timezone)}. `
            : ''}
          {c.lastSyncAt
            ? `Numbers fetched ${formatDateTime(c.lastSyncAt, timezone)}; they update every day.`
            : ''}
        </p>
      </CardContent>
    </Card>
  );
}

function GroupTable({
  rows,
  label,
  page,
}: {
  rows: SearchGrouped[];
  label: string;
  page?: boolean;
}) {
  if (!rows.length) return <p className="px-5 pb-5 text-sm text-muted-foreground">No data yet.</p>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TR>
            <TH>{label}</TH>
            <TH className="text-right">Clicks</TH>
            <TH className="text-right">Shown</TH>
            <TH className="text-right">Click rate</TH>
            <TH className="text-right">Position</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.key}>
              <TD className="max-w-[320px] truncate" title={r.key}>
                {page ? r.key.replace(/^https?:\/\/[^/]+/, '') || '/' : r.key}
              </TD>
              <TD className="tabular text-right">{formatNumber(r.clicks)}</TD>
              <TD className="tabular text-right">{formatNumber(r.impressions)}</TD>
              <TD className="tabular text-right">{ctrText(r.ctr)}</TD>
              <TD className="tabular text-right">{positionText(r.position)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function ReportView({
  report,
  days,
  setDays,
  orgId,
}: {
  report: SearchReport;
  days: Days;
  setDays: (d: Days) => void;
  orgId: string;
}) {
  const tiles = totalsTiles(report.totals, report.previous);
  const [allOpps, setAllOpps] = useState(false);
  const opps = allOpps ? report.opportunities : report.opportunities.slice(0, OPPS_SHOWN);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {formatDate(report.period.from)} to {formatDate(report.period.to)}, Google web search
        </p>
        <Segmented
          label="Period"
          value={days}
          onChange={setDays}
          options={[
            { value: '7', label: '7 days' },
            { value: '28', label: '28 days' },
            { value: '90', label: '90 days' },
          ]}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Stat
            key={t.key}
            label={t.label}
            value={t.value}
            sub={t.change ? `${t.change} on the ${report.period.days} days before` : undefined}
          />
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Clicks from Google per day</CardTitle>
        </CardHeader>
        <CardContent>
          <ColumnChart
            label="Day"
            data={report.series.map((d) => ({ key: d.date, values: [d.clicks] }))}
            series={[{ name: 'Clicks', color: '--series-1' }]}
            formatValue={(n) => formatNumber(n)}
            formatTick={(n) => formatNumber(n, { compact: true })}
            formatKey={shortDay}
            formatKeyLong={longDay}
            height={200}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Times shown on Google per day</CardTitle>
        </CardHeader>
        <CardContent>
          <ColumnChart
            label="Day"
            data={report.series.map((d) => ({ key: d.date, values: [d.impressions] }))}
            series={[{ name: 'Times shown', color: '--series-1' }]}
            formatValue={(n) => formatNumber(n)}
            formatTick={(n) => formatNumber(n, { compact: true })}
            formatKey={shortDay}
            formatKeyLong={longDay}
            height={200}
          />
        </CardContent>
      </Card>

      {report.opportunities.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Opportunities</CardTitle>
            <CardDescription>
              Phrases where a better title, description or product text can bring more visitors
              {report.rowsPeriod
                ? ` (${formatDate(report.rowsPeriod.from)} to ${formatDate(report.rowsPeriod.to)})`
                : ''}
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3" data-testid="opportunities">
              {opps.map((o) => (
                <li key={`${o.kind}-${o.query}-${o.page}`} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">“{o.query}”</span>
                    <Badge tone={o.kind === 'almost_page_one' ? 'info' : 'warning'}>
                      {o.kind === 'almost_page_one' ? 'Almost on page one' : 'Few clicks'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    Shown {formatNumber(o.impressions)} times at position {positionText(o.position)}
                    , clicked {formatNumber(o.clicks)} {o.clicks === 1 ? 'time' : 'times'} (
                    {ctrText(o.ctr)}
                    {o.expectedCtr
                      ? `; pages there usually get ${ctrText(o.expectedCtr)}`
                      : ''}).{' '}
                    {o.kind === 'almost_page_one'
                      ? 'Use the phrase in the title and description, and add a question about it.'
                      : 'Make the search title and meta description give a reason to click.'}
                  </p>
                  <p className="mt-1 text-[13px]">
                    {o.product ? (
                      <Link
                        href={productHref(orgId, o.product.id)}
                        className="text-primary hover:underline"
                      >
                        Edit {o.product.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">
                        {o.page.replace(/^https?:\/\/[^/]+/, '') || '/'}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
            {report.opportunities.length > OPPS_SHOWN && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => setAllOpps((a) => !a)}
              >
                {allOpps ? 'Show fewer' : `Show all ${report.opportunities.length}`}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Top search phrases</CardTitle>
          </CardHeader>
          <GroupTable rows={report.topQueries} label="Phrase" />
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Top pages</CardTitle>
          </CardHeader>
          <GroupTable rows={report.topPages} label="Page" page />
        </Card>
      </div>
    </>
  );
}
