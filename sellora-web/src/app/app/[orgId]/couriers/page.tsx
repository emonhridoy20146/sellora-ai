'use client';

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Settings, Truck } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { commerceKeys } from '@/components/commerce/hooks';
import { OrdersTable } from '@/components/commerce/orders-table';
import { PageError } from '@/components/commerce/page-error';
import { BulkBookDialog } from '@/components/couriers/bulk-book-dialog';
import { courierKeys, useCourierChoices, useFraudBatch } from '@/components/couriers/data';
import { useRiskVisible } from '@/components/couriers/risk-card';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMore } from '@/components/ui/load-more';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { api } from '@/lib/api/client';
import type { Order, Page, ShipmentFilter, ShipmentSummary } from '@/lib/api/types';
import { SHIPMENT_STATUS, isShipmentFilter } from '@/lib/couriers';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

type Tab = Exclude<ShipmentFilter, 'none' | 'queued'>;

const TABS: { value: Tab; label: string; empty: string }[] = [
  { value: 'ready', label: 'Ready to send', empty: 'No confirmed or packed order is waiting.' },
  { value: 'attention', label: 'Needs a look', empty: 'Nothing needs a look.' },
  { value: 'sending', label: 'Sending', empty: 'Nothing is on its way to a courier.' },
  { value: 'booked', label: 'Booked', empty: 'No parcel is waiting for pickup.' },
  { value: 'picked_up', label: 'Picked up', empty: 'No parcel was just picked up.' },
  { value: 'in_transit', label: 'On the way', empty: 'No parcel is on the way.' },
  { value: 'on_hold', label: 'On hold', empty: 'No parcel is on hold.' },
  { value: 'returning', label: 'Coming back', empty: 'No parcel is coming back.' },
  { value: 'returned', label: 'Returned', empty: 'No parcel came back.' },
  { value: 'partly_delivered', label: 'Partly delivered', empty: 'None.' },
  { value: 'delivered', label: 'Delivered', empty: 'No parcel delivered yet.' },
  { value: 'failed', label: 'Not booked', empty: 'No refused booking.' },
  { value: 'cancelled', label: 'Cancelled', empty: 'No cancelled booking.' },
];

function countFor(s: ShipmentSummary | undefined, tab: Tab): number | undefined {
  if (!s) return undefined;
  if (tab === 'ready') return s.ready;
  if (tab === 'attention') return s.attention;
  // Waiting to send and sending show together: both are seconds away from booked.
  if (tab === 'sending') return s.byStatus.sending + s.byStatus.queued;
  return s.byStatus[tab];
}

/** Parcels across all orders: what is ready to go, on the way, back, or needs a look. */
export default function CouriersPage() {
  const { org, can, modules } = useOrg();
  const params = useSearchParams();
  const inPlan = modules === null || modules.includes('couriers');
  const riskVisible = useRiskVisible();
  const [tab, setTab] = useState<Tab>(() => {
    const v = params.get('view');
    return isShipmentFilter(v) && v !== 'none' && v !== 'queued' ? v : 'ready';
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkIds, setBulkIds] = useState<string[] | null>(null);

  const summary = useQuery({
    queryKey: [...courierKeys.all(org.id), 'summary'],
    queryFn: () => api<ShipmentSummary>(`/orgs/${org.id}/parcels/summary`),
    enabled: inPlan,
    refetchInterval: 30_000,
  });
  const choices = useCourierChoices(org.id, inPlan);
  const list = useInfiniteQuery({
    queryKey: [...commerceKeys.orders(org.id), 'couriers', tab],
    queryFn: ({ pageParam }) =>
      api<Page<Order>>(`/orgs/${org.id}/orders`, {
        query: { shipment: tab, limit: 25, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: inPlan,
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) =>
        p.items.some((o) => o.shipment?.status === 'queued' || o.shipment?.status === 'sending'),
      )
        ? 5000
        : false,
  });
  // Parcels waiting to be sent show with those being sent.
  const queued = useQuery({
    queryKey: [...commerceKeys.orders(org.id), 'couriers', 'queued'],
    queryFn: () =>
      api<Page<Order>>(`/orgs/${org.id}/orders`, { query: { shipment: 'queued', limit: 100 } }),
    enabled: inPlan && tab === 'sending',
    refetchInterval: 5000,
  });
  const items = [
    ...(tab === 'sending' ? (queued.data?.items ?? []) : []),
    ...(list.data?.pages.flatMap((p) => p.items) ?? []),
  ];
  const risk = useFraudBatch(
    org.id,
    tab === 'ready' ? items.map((o) => o.customer.phone) : [],
    riskVisible && tab === 'ready',
  );

  if (!can('orders.view'))
    return (
      <EmptyState icon={Truck} title="Your role does not include orders">
        Ask the business owner to give your role access to orders.
      </EmptyState>
    );
  if (!inPlan)
    return (
      <EmptyState
        icon={Truck}
        title="Courier booking is not in your plan"
        action={
          can('billing.view') && (
            <Button asChild>
              <Link href={`/app/${org.id}/billing/plans`}>See plans</Link>
            </Button>
          )
        }
      >
        Upgrade to book Steadfast, Pathao and RedX parcels from your orders and track them here.
      </EmptyState>
    );

  const s = summary.data;
  const onTheWay = s
    ? s.byStatus.queued +
      s.byStatus.sending +
      s.byStatus.booked +
      s.byStatus.picked_up +
      s.byStatus.in_transit +
      s.byStatus.on_hold
    : undefined;
  const current = TABS.find((t) => t.value === tab)!;
  const canSend = tab === 'ready' && can('orders.manage');

  return (
    <>
      <PageHeader
        title="Couriers"
        description="Every parcel booked through Sellora, and the orders waiting to go. Statuses update from the couriers by themselves."
        actions={
          can('org.integrations.manage') && (
            <Button asChild variant="outline">
              <Link href={`/app/${org.id}/settings/couriers`}>
                <Settings /> Courier accounts
              </Link>
            </Button>
          )
        }
      />
      {choices.data && choices.data.length === 0 && (
        <Alert tone="info" className="mb-6" title="No courier connected yet">
          {can('org.integrations.manage') ? (
            <>
              Connect Steadfast, Pathao or RedX in{' '}
              <Link
                href={`/app/${org.id}/settings/couriers`}
                className="text-primary hover:underline"
              >
                Settings › Couriers
              </Link>{' '}
              to book parcels from your orders.
            </>
          ) : (
            'Ask the business owner to connect your courier accounts.'
          )}
        </Alert>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Ready to send" value={s ? s.ready : '…'} sub="Confirmed or packed" />
        <Stat
          label="Needs a look"
          value={s ? s.attention : '…'}
          sub={s?.attention ? 'Returns, lost replies, holds' : 'All clear'}
        />
        <Stat label="With couriers" value={onTheWay ?? '…'} sub="Booked or on the way" />
        <Stat
          label="Cash to collect"
          value={s ? formatMoney(s.withCouriers.toCollectMinor, s.currency) : '…'}
          sub={s ? `From ${s.withCouriers.orders} parcels with couriers` : undefined}
        />
      </div>
      <nav aria-label="Courier status" className="-mx-1 mb-4 overflow-x-auto">
        <ul className="flex min-w-max gap-1 px-1">
          {TABS.map((t) => {
            const n = countFor(s, t.value);
            // Rare statuses only show while something is in them.
            if (
              n === 0 &&
              ['partly_delivered', 'on_hold', 'returning', 'cancelled', 'sending'].includes(
                t.value,
              ) &&
              tab !== t.value
            )
              return null;
            return (
              <li key={t.value}>
                <button
                  type="button"
                  aria-pressed={tab === t.value}
                  onClick={() => {
                    setTab(t.value);
                    setSelected(new Set());
                  }}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium transition-colors',
                    tab === t.value
                      ? 'border-primary bg-info-soft text-primary'
                      : 'bg-card text-muted-foreground hover:text-foreground',
                    t.value === 'attention' && n ? 'border-warning/40' : '',
                  )}
                >
                  {t.label}
                  {n !== undefined && <span className="tabular opacity-80">{n}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <Card>
        {canSend && (
          <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
            <span className="mr-auto text-sm text-muted-foreground">
              {selected.size
                ? `${selected.size} selected`
                : 'Select orders to send them to a courier together.'}
            </span>
            <Button size="sm" disabled={!selected.size} onClick={() => setBulkIds([...selected])}>
              <Truck /> Send to courier
            </Button>
          </div>
        )}
        <CardContent className={cn('px-0 py-0', list.isPlaceholderData && 'opacity-60')}>
          {list.isPending ? (
            <Skeleton className="m-5 h-40" />
          ) : list.isError ? (
            <PageError error={list.error} onRetry={() => void list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={Truck} title={current.empty} />
          ) : (
            <>
              {tab !== 'ready' &&
                tab !== 'attention' &&
                tab !== 'failed' &&
                tab !== 'cancelled' && (
                  <p className="border-b px-5 py-2.5 text-[13px] text-muted-foreground">
                    {SHIPMENT_STATUS[tab].label}: open an order for its timeline and tracking link.
                  </p>
                )}
              <OrdersTable
                orgId={org.id}
                orders={items}
                timezone={org.timezone}
                risk={risk}
                {...(canSend ? { selected, onSelect: setSelected } : {})}
              />
            </>
          )}
          <LoadMore
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          />
        </CardContent>
      </Card>
      <BulkBookDialog
        orderIds={bulkIds ?? []}
        open={bulkIds !== null}
        onOpenChange={(v) => {
          if (!v) {
            setBulkIds(null);
            void summary.refetch();
          }
        }}
        onQueued={() => setSelected(new Set())}
      />
    </>
  );
}
