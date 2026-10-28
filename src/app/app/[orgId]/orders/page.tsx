'use client';

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { PanelsTopLeft, Plus, Printer, Search, ShoppingBag, Truck, X } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { commerceKeys } from '@/components/commerce/hooks';
import { OrdersTable } from '@/components/commerce/orders-table';
import { PageError } from '@/components/commerce/page-error';
import { BulkBookDialog } from '@/components/couriers/bulk-book-dialog';
import { useFraudBatch } from '@/components/couriers/data';
import { useRiskVisible } from '@/components/couriers/risk-card';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, NativeSelect } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import type { Order, OrderCounts, OrderStatus, Page, ShipmentFilter } from '@/lib/api/types';
import { ORDER_STATUS, ORDER_STATUS_ORDER } from '@/lib/commerce';
import { SHIPMENT_FILTERS, isShipmentFilter } from '@/lib/couriers';
import { cn } from '@/lib/utils';

export default function OrdersPage() {
  const { org, can, modules } = useOrg();
  const couriersInPlan = modules === null || modules.includes('couriers');
  const riskVisible = useRiskVisible();
  const canSelect = can('orders.print') || (couriersInPlan && can('orders.manage'));
  const params = useSearchParams();
  const [status, setStatus] = useState<OrderStatus | ''>(() => {
    const v = params.get('status');
    return ORDER_STATUS_ORDER.find((s) => s === v) ?? '';
  });
  const [search, setSearch] = useState('');
  const [payment, setPayment] = useState('');
  const [shipment, setShipment] = useState<ShipmentFilter | ''>(() => {
    const v = params.get('shipment');
    return isShipmentFilter(v) ? v : '';
  });
  // Opened from a landing page ("Orders from this page"): only that page's orders.
  const [landingPageId, setLandingPageId] = useState<string>(() => {
    const v = params.get('landingPageId') ?? '';
    return /^[a-f0-9]{24}$/.test(v) ? v : '';
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The orders being sent, kept while the dialog shows the result (the selection is cleared).
  const [bulkIds, setBulkIds] = useState<string[] | null>(null);
  const q = useDebounced(search.trim());
  const filtered = Boolean(q || status || payment || shipment || landingPageId);

  const counts = useQuery({
    queryKey: [...commerceKeys.orders(org.id), 'counts'],
    queryFn: () => api<OrderCounts>(`/orgs/${org.id}/orders/counts`),
  });
  const list = useInfiniteQuery({
    queryKey: [...commerceKeys.orders(org.id), 'list', status, q, payment, shipment, landingPageId],
    queryFn: ({ pageParam }) =>
      api<Page<Order>>(`/orgs/${org.id}/orders`, {
        query: {
          status,
          q,
          paymentStatus: payment,
          shipment,
          landingPageId: landingPageId || undefined,
          limit: 25,
          cursor: pageParam,
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    // While parcels are on their way to the courier, follow them until they are booked.
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) =>
        p.items.some((o) => o.shipment?.status === 'queued' || o.shipment?.status === 'sending'),
      )
        ? 5000
        : false,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const risk = useFraudBatch(
    org.id,
    items.filter((o) => o.status !== 'cancelled').map((o) => o.customer.phone),
    riskVisible,
  );
  const printHref = (doc: 'invoice' | 'slip') =>
    `/app/${org.id}/orders/print?doc=${doc}&ids=${[...selected].join(',')}`;

  const tabs: { value: OrderStatus | ''; label: string; count?: number }[] = [
    { value: '', label: 'All', count: counts.data?.all },
    ...ORDER_STATUS_ORDER.map((s) => ({
      value: s,
      label: ORDER_STATUS[s].label,
      count: counts.data?.[s],
    })),
  ];

  return (
    <>
      <PageHeader
        title="Orders"
        description="Orders from every channel. Confirming an order takes its items out of stock."
        actions={
          can('orders.create') && (
            <Button asChild>
              <Link href={`/app/${org.id}/orders/new`}>
                <Plus /> New order
              </Link>
            </Button>
          )
        }
      />
      <nav aria-label="Order status" className="-mx-1 mb-4 overflow-x-auto">
        <ul className="flex min-w-max gap-1 px-1">
          {tabs.map((t) => (
            <li key={t.value || 'all'}>
              <button
                type="button"
                aria-pressed={status === t.value}
                onClick={() => {
                  setStatus(t.value);
                  setSelected(new Set());
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium transition-colors',
                  status === t.value
                    ? 'border-primary bg-info-soft text-primary'
                    : 'bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {t.count !== undefined && <span className="tabular opacity-80">{t.count}</span>}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
          <div className="relative min-w-56 flex-1">
            <Search
              className="absolute top-2.5 left-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <label htmlFor="o-search" className="sr-only">
              Search orders
            </label>
            <Input
              id="o-search"
              className="h-9 pl-8"
              placeholder="Order number, customer name or phone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label htmlFor="o-pay" className="sr-only">
            Payment
          </label>
          <NativeSelect
            id="o-pay"
            className="w-36"
            value={payment}
            onChange={(e) => setPayment(e.target.value)}
          >
            <option value="">Any payment</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Part paid</option>
            <option value="paid">Paid</option>
            <option value="refunded">Refunded</option>
          </NativeSelect>
          {couriersInPlan && (
            <>
              <label htmlFor="o-ship" className="sr-only">
                Courier status
              </label>
              <NativeSelect
                id="o-ship"
                className="w-48"
                value={shipment}
                onChange={(e) => {
                  setShipment(e.target.value as ShipmentFilter | '');
                  setSelected(new Set());
                }}
              >
                {SHIPMENT_FILTERS.map((f) => (
                  <option key={f.value || 'any'} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </NativeSelect>
            </>
          )}
          {landingPageId && (
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-info-soft px-3 py-1 text-[13px] text-primary">
              <PanelsTopLeft className="size-3.5" aria-hidden />
              {items.find((o) => o.landingPage?.id === landingPageId)?.landingPage?.name ??
                'One landing page'}
              <button
                type="button"
                className="ml-0.5 rounded-full hover:bg-primary/10"
                aria-label="Show orders from everywhere"
                onClick={() => {
                  setLandingPageId('');
                  setSelected(new Set());
                }}
              >
                <X className="size-3.5" />
              </button>
            </span>
          )}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{selected.size} selected</span>
              {couriersInPlan && can('orders.manage') && (
                <Button size="sm" onClick={() => setBulkIds([...selected])}>
                  <Truck /> Send to courier
                </Button>
              )}
              {can('orders.print') && (
                <>
                  <Button asChild size="sm" variant="outline">
                    <a href={printHref('invoice')} target="_blank" rel="noopener">
                      <Printer /> Invoices
                    </a>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <a href={printHref('slip')} target="_blank" rel="noopener">
                      <Printer /> Packing slips
                    </a>
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
        <CardContent className={cn('px-0 py-0', list.isPlaceholderData && 'opacity-60')}>
          {list.isPending ? (
            <Skeleton className="m-5 h-40" />
          ) : list.isError ? (
            <PageError error={list.error} onRetry={() => void list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={ShoppingBag}
              title={filtered ? 'No orders match' : 'No orders yet'}
              action={
                !filtered &&
                can('orders.create') && (
                  <Button asChild>
                    <Link href={`/app/${org.id}/orders/new`}>
                      <Plus /> Create an order
                    </Link>
                  </Button>
                )
              }
            >
              {!filtered &&
                'Orders you take on the phone or in chat go here. Orders from the inbox and your store will land here too once those are connected.'}
            </EmptyState>
          ) : (
            <OrdersTable
              orgId={org.id}
              orders={items}
              timezone={org.timezone}
              showCourier={couriersInPlan}
              risk={risk}
              {...(canSelect ? { selected, onSelect: setSelected } : {})}
            />
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
        onOpenChange={(v) => !v && setBulkIds(null)}
        onQueued={() => setSelected(new Set())}
      />
    </>
  );
}
