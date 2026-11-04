'use client';

import {
  ExternalLink,
  FileText,
  Megaphone,
  MousePointerClick,
  Plus,
  ShoppingBag,
} from 'lucide-react';
import Link from 'next/link';
import { PageError } from '@/components/commerce/page-error';
import { useLandingPages } from '@/components/landing/hooks';
import { LandingStatusBadge } from '@/components/landing/status';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatMoney, formatNumber, formatRelative } from '@/lib/format';
import { conversionText } from '@/lib/landing';

const STEPS = [
  {
    icon: FileText,
    title: 'Pick a product and a template',
    text: 'The page starts filled with the product’s name, pictures and price.',
  },
  {
    icon: Megaphone,
    title: 'Write the offer',
    text: 'Packages, an add-on, reviews, a countdown: everything a buyer needs to decide.',
  },
  {
    icon: ShoppingBag,
    title: 'Publish and run ads to it',
    text: 'Orders arrive in Orders with the page and the ad they came from.',
  },
];

export default function LandingPagesPage() {
  const { org, can } = useOrg();
  const list = useLandingPages(org.id);
  const base = `/app/${org.id}/landing-pages`;
  const full = list.data && list.data.limit !== null && list.data.used >= list.data.limit;
  const createButton = can('stores.manage') && !full && (
    <Button asChild>
      <Link href={`${base}/new`}>
        <Plus /> New landing page
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Landing pages"
        description="One page for one product, made for ads: the offer, the reasons to buy and an order form. Shoppers pay cash on delivery."
        actions={list.data?.items.length ? createButton : undefined}
      />
      {list.isPending ? (
        <Skeleton className="h-48" />
      ) : list.isError ? (
        <PageError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <Card>
          <CardContent className="grid gap-6 py-8">
            <div className="text-center">
              <h2 className="text-lg font-semibold">Sell one product from one page</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The page lives on your store’s address, so you need a store first. It does not have
                to be open.
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
                  Ask the owner or an admin to make a landing page.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {full && (
            <p className="text-sm text-muted-foreground">
              Your plan allows {list.data.limit} landing page{list.data.limit === 1 ? '' : 's'}.{' '}
              {can('billing.view') && (
                <Link href={`/app/${org.id}/billing/plans`} className="text-primary underline">
                  Change plan
                </Link>
              )}
            </p>
          )}
          <Card>
            <CardContent className="px-0 py-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Page</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Visitors</TH>
                    <TH className="text-right">Orders</TH>
                    <TH className="text-right">Conversion</TH>
                    <TH className="text-right">Order value</TH>
                    <TH>
                      <span className="sr-only">Open</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {list.data.items.map((p) => {
                    const t = p.last30Days ?? { visitors: 0, orders: 0, revenueMinor: 0 };
                    return (
                      <TR key={p.id}>
                        <TD className="max-w-80">
                          <Link
                            href={`${base}/${p.id}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {p.name}
                          </Link>
                          <span className="block truncate text-xs text-muted-foreground">
                            {p.store?.name ?? 'Store removed'} · /{p.slug}
                          </span>
                        </TD>
                        <TD>
                          <div className="flex flex-col items-start gap-1">
                            <LandingStatusBadge status={p.status} />
                            {p.status === 'live' && p.submission?.status === 'pending' && (
                              <span className="text-xs text-muted-foreground">
                                Changes in review
                              </span>
                            )}
                            {p.status !== 'draft' && p.hasUnpublishedChanges && !p.submission && (
                              <span className="text-xs text-muted-foreground">
                                Unpublished changes
                              </span>
                            )}
                          </div>
                        </TD>
                        <TD className="tabular text-right">{formatNumber(t.visitors)}</TD>
                        <TD className="tabular text-right">{formatNumber(t.orders)}</TD>
                        <TD className="tabular text-right">
                          {conversionText(t.visitors ? t.orders / t.visitors : null)}
                        </TD>
                        <TD className="tabular text-right">
                          {formatMoney(t.revenueMinor, org.currency)}
                        </TD>
                        <TD className="text-right">
                          {p.status === 'live' && p.url ? (
                            <Button asChild variant="ghost" size="icon-sm">
                              <a
                                href={p.url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`Open ${p.name}`}
                              >
                                <ExternalLink />
                              </a>
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {formatRelative(p.updatedAt)}
                            </span>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </CardContent>
          </Card>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MousePointerClick className="size-3.5" aria-hidden /> Numbers are for the last 30 days.
            A visitor is one browser on one day, so they are close to, not exactly, what your ads
            report.
          </p>
        </div>
      )}
    </>
  );
}
