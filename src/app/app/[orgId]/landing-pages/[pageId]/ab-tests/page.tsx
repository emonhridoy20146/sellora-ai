'use client';

import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Trophy } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageError } from '@/components/commerce/page-error';
import { landingKeys, useAbTests, useLandingPage } from '@/components/landing/hooks';
import { LandingPreviewButton } from '@/components/landing/preview-button';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { AbTest, LandingPage } from '@/lib/api/types';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { AB_END_REASON, abVerdict, formatLift, formatRate } from '@/lib/landing';

/** Visitors, buyers, orders, sales and buying rate of A and B side by side. */
function Counts({ test, currency }: { test: AbTest; currency: string }) {
  const rows = [
    {
      key: 'a' as const,
      name: `A: live version ${test.a.version}`,
      share: 100 - test.settings.splitB,
      rate: test.result.rateA,
    },
    {
      key: 'b' as const,
      name: 'B: new version',
      share: test.settings.splitB,
      rate: test.result.rateB,
    },
  ];
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TR>
            <TH>Version</TH>
            <TH className="text-right">Visitors</TH>
            <TH className="text-right">Buyers</TH>
            <TH className="text-right">Orders</TH>
            <TH className="text-right">Sales</TH>
            <TH className="text-right">Buying rate</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => {
            const c = test.counts[r.key];
            const won =
              test.winner === r.key || (test.status === 'running' && test.result.leader === r.key);
            return (
              <TR key={r.key} data-version={r.key}>
                <TD>
                  <span className="flex items-center gap-1.5 font-medium">
                    {r.name}
                    {won && <Trophy className="size-3.5 text-success" aria-label="Better" />}
                  </span>
                  <span className="text-xs text-muted-foreground">{r.share}% of visitors</span>
                </TD>
                <TD className="text-right tabular-nums">{formatNumber(c.visitors)}</TD>
                <TD className="text-right tabular-nums">{formatNumber(c.buyers)}</TD>
                <TD className="text-right tabular-nums">{formatNumber(c.orders)}</TD>
                <TD className="text-right tabular-nums">{formatMoney(c.revenueMinor, currency)}</TD>
                <TD className="text-right font-medium tabular-nums">{formatRate(r.rate)}</TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}

function Running({ page, test }: { page: LandingPage; test: AbTest }) {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const [choosing, setChoosing] = useState<'a' | 'b' | null>(null);
  const verdict = abVerdict(test);

  const end = async (keep: 'a' | 'b') => {
    try {
      const next = await api<LandingPage>(`/orgs/${org.id}/landing-pages/${page.id}/ab-tests/end`, {
        body: { keep },
      });
      queryClient.setQueryData(landingKeys.page(org.id, page.id), next);
      void queryClient.invalidateQueries({ queryKey: landingKeys.abTests(org.id, page.id) });
      void queryClient.invalidateQueries({ queryKey: landingKeys.versions(org.id, page.id) });
      void queryClient.invalidateQueries({ queryKey: landingKeys.all(org.id), exact: true });
      toast.success(
        keep === 'b'
          ? 'Version B is live for everyone now.'
          : 'Test ended. The live version stays.',
      );
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  return (
    <Card data-test-status="running">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Running test <Badge tone="info">Running</Badge>
        </CardTitle>
        <CardDescription>
          Started {formatDate(test.startedAt)}
          {test.endsBy && <> · ends by {formatDateTime(test.endsBy)}</>} · numbers update every half
          minute.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Counts test={test} currency={org.currency} />
        <Alert tone={verdict.tone} title={verdict.title}>
          <p>{verdict.text}</p>
        </Alert>
        <p className="text-[13px] text-muted-foreground">
          {test.settings.autoWinner
            ? `It ends by itself once each version had ${formatNumber(test.settings.minVisitors)} visitors and one sells clearly better. You can also end it now.`
            : 'You choose the winner. When the days are up, the live version stays.'}{' '}
          A buyer is a visitor who placed at least one order.
        </p>
        <div className="flex flex-wrap gap-2">
          <LandingPreviewButton
            orgId={org.id}
            pageId={page.id}
            kind="ab_test"
            label="Preview version B"
            size="sm"
          />
          {can('stores.publish') && (
            <>
              <Button size="sm" variant="outline" onClick={() => setChoosing('a')}>
                Keep A, end test
              </Button>
              <Button size="sm" onClick={() => setChoosing('b')}>
                Make B live
              </Button>
            </>
          )}
        </div>
        <ConfirmDialog
          open={choosing !== null}
          onOpenChange={(o) => !o && setChoosing(null)}
          title={choosing === 'b' ? 'Make version B live?' : 'Keep version A?'}
          description={
            choosing === 'b'
              ? 'Every visitor sees version B from now on. It becomes a new version you can go back from.'
              : 'Every visitor sees the live version again. Version B stays in your draft.'
          }
          confirmLabel={choosing === 'b' ? 'Make B live' : 'Keep A'}
          onConfirm={() => end(choosing!)}
        />
      </CardContent>
    </Card>
  );
}

function Ended({ test, currency }: { test: AbTest; currency: string }) {
  return (
    <li className="grid gap-3 rounded-lg border p-4" data-test-status="ended">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {formatDate(test.startedAt)} to {formatDate(test.endedAt)} · {test.days}{' '}
          {test.days === 1 ? 'day' : 'days'}
        </p>
        <Badge tone={test.winner === 'b' ? 'success' : 'neutral'}>
          {test.winner === 'b'
            ? `B made live${test.publishedVersion ? ` as version ${test.publishedVersion}` : ''}`
            : 'A kept'}
        </Badge>
      </div>
      <p className="text-[13px] text-muted-foreground">
        {test.endReason ? AB_END_REASON[test.endReason] : 'Ended'} · B against A:{' '}
        {formatLift(test.result.lift)}
      </p>
      <Counts test={test} currency={currency} />
    </li>
  );
}

export default function AbTestsPage() {
  const { org } = useOrg();
  const { pageId } = useParams<{ pageId: string }>();
  const page = useLandingPage(org.id, pageId);
  const tests = useAbTests(org.id, pageId);

  if (tests.isPending || !page.data) return <Skeleton className="h-64" />;
  if (tests.isError) return <PageError error={tests.error} onRetry={() => void tests.refetch()} />;
  const running = tests.data.items.find((t) => t.status === 'running');
  const ended = tests.data.items.filter((t) => t.status === 'ended');

  return (
    <div className="grid gap-6">
      {running && <Running page={page.data} test={running} />}
      {!running && (
        <Card>
          <EmptyState icon={FlaskConical} title="No test running">
            Change the page in the editor, then choose Publish › “As an A/B test”. Some visitors see
            the new version and the rest the live one, and you keep the one that sells better.
          </EmptyState>
        </Card>
      )}
      {ended.length > 0 && (
        <section className="grid gap-3">
          <h2 className="text-sm font-medium">Earlier tests</h2>
          <ul className="grid gap-3">
            {ended.map((t) => (
              <Ended key={t.id} test={t} currency={org.currency} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
