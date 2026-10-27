'use client';

import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageError } from '@/components/commerce/page-error';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import type { Order, PrintBundle } from '@/lib/api/types';
import { PAYMENT_STATUS, addressLines, paymentMethodLabel } from '@/lib/commerce';
import { formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

type Doc = 'invoice' | 'slip';
type Business = PrintBundle['business'];

function BusinessBlock({ b }: { b: Business }) {
  return (
    <div>
      <p className="text-lg font-semibold">{b.legalName || b.name}</p>
      {b.address && <p className="whitespace-pre-line">{b.address}</p>}
      <p>{[b.phone, b.email, b.website].filter(Boolean).join(' · ')}</p>
    </div>
  );
}

function ShipTo({ o, large }: { o: Order; large?: boolean }) {
  const a = o.shippingAddress;
  return (
    <div className={cn(large && 'text-base')}>
      <p className="text-xs font-semibold text-muted-foreground uppercase">Deliver to</p>
      <p className="font-semibold">{a.name || o.customer.name}</p>
      {addressLines(a).map((l) => (
        <p key={l}>{l}</p>
      ))}
      <p className="font-medium">{a.phone || o.customer.phone}</p>
    </div>
  );
}

function Invoice({ o, bundle }: { o: Order; bundle: PrintBundle }) {
  const money = (n: number) => formatMoney(n, o.currency);
  return (
    <article className="print-page mx-auto grid w-full max-w-3xl gap-6 rounded-lg border bg-card p-8 text-sm shadow-xs print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
        <BusinessBlock b={bundle.business} />
        <div className="text-right">
          <p className="text-xl font-semibold">Invoice</p>
          <p className="font-mono">{o.number}</p>
          <p>{formatDate(o.placedAt, bundle.business.timezone)}</p>
        </div>
      </header>
      <section className="grid gap-6 sm:grid-cols-2 print:grid-cols-2">
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase">Customer</p>
          <p className="font-semibold">{o.customer.name}</p>
          {o.customer.phone && <p>{o.customer.phone}</p>}
          {o.customer.email && <p>{o.customer.email}</p>}
        </div>
        <ShipTo o={o} />
      </section>
      <table className="w-full">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground uppercase">
            <th className="py-2 font-semibold">Item</th>
            <th className="py-2 text-right font-semibold">Price</th>
            <th className="py-2 text-right font-semibold">Qty</th>
            <th className="py-2 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {o.items.map((i) => (
            <tr key={i.variantId} className="border-b">
              <td className="py-2">
                {i.name}
                {i.variantTitle && (
                  <span className="text-muted-foreground"> ({i.variantTitle})</span>
                )}
              </td>
              <td className="tabular py-2 text-right">{money(i.unitPriceMinor)}</td>
              <td className="tabular py-2 text-right">{i.quantity}</td>
              <td className="tabular py-2 text-right">{money(i.totalMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="max-w-sm">
          <p>
            Payment: {paymentMethodLabel(o.payment.method)} ·{' '}
            {PAYMENT_STATUS[o.payment.status].label}
          </p>
          {o.payment.reference && <p>Transaction: {o.payment.reference}</p>}
          {o.customerNote && <p className="mt-2 whitespace-pre-line">Note: {o.customerNote}</p>}
        </div>
        <dl className="grid w-64 gap-1">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd className="tabular">{money(o.subtotalMinor)}</dd>
          </div>
          {o.discountMinor > 0 && (
            <div className="flex justify-between">
              <dt>Discount</dt>
              <dd className="tabular">−{money(o.discountMinor)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>Delivery</dt>
            <dd className="tabular">{money(o.deliveryChargeMinor)}</dd>
          </div>
          <div className="flex justify-between border-t pt-1 text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular">{money(o.totalMinor)}</dd>
          </div>
          {o.payment.paidMinor > 0 && (
            <div className="flex justify-between">
              <dt>Paid</dt>
              <dd className="tabular">{money(o.payment.paidMinor)}</dd>
            </div>
          )}
          <div className="flex justify-between text-base font-semibold">
            <dt>Due</dt>
            <dd className="tabular">{money(o.dueMinor)}</dd>
          </div>
          {o.refundDueMinor > 0 && (
            <div className="flex justify-between font-semibold">
              <dt>Refund due</dt>
              <dd className="tabular">{money(o.refundDueMinor)}</dd>
            </div>
          )}
        </dl>
      </div>
      {bundle.invoiceNote && (
        <footer className="border-t pt-4 text-center whitespace-pre-line text-muted-foreground">
          {bundle.invoiceNote}
        </footer>
      )}
    </article>
  );
}

function PackingSlip({ o, bundle }: { o: Order; bundle: PrintBundle }) {
  return (
    <article className="print-page mx-auto grid w-full max-w-3xl gap-5 rounded-lg border bg-card p-8 text-sm shadow-xs print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase">From</p>
          <p className="font-semibold">{bundle.business.name}</p>
          {bundle.business.phone && <p>{bundle.business.phone}</p>}
        </div>
        <div className="text-right">
          <p className="text-xl font-semibold">Packing slip</p>
          <p className="font-mono text-lg">{o.number}</p>
          <p>{formatDate(o.placedAt, bundle.business.timezone)}</p>
        </div>
      </header>
      <div className="flex flex-wrap items-start justify-between gap-6">
        <ShipTo o={o} large />
        <div className="rounded-md border-2 border-foreground px-4 py-2 text-right">
          <p className="text-xs font-semibold uppercase">Collect on delivery</p>
          <p className="tabular text-2xl font-bold">{formatMoney(o.dueMinor, o.currency)}</p>
        </div>
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground uppercase">
            <th className="w-8 py-2" aria-label="Packed" />
            <th className="py-2 font-semibold">Item</th>
            <th className="py-2 font-semibold">SKU</th>
            <th className="py-2 text-right font-semibold">Qty</th>
          </tr>
        </thead>
        <tbody>
          {o.items.map((i) => (
            <tr key={i.variantId} className="border-b">
              <td className="py-2">
                <span className="inline-block size-4 rounded-sm border border-foreground" />
              </td>
              <td className="py-2">
                {i.name}
                {i.variantTitle && <span className="font-medium"> ({i.variantTitle})</span>}
              </td>
              <td className="py-2 font-mono text-xs">{i.sku ?? ''}</td>
              <td className="tabular py-2 text-right text-base font-semibold">{i.quantity}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(o.customerNote || o.internalNote) && (
        <div className="grid gap-1">
          {o.customerNote && <p className="whitespace-pre-line">Customer note: {o.customerNote}</p>}
          {o.internalNote && <p className="whitespace-pre-line">Packing note: {o.internalNote}</p>}
        </div>
      )}
    </article>
  );
}

function PrintView() {
  const { org } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const doc: Doc = params.get('doc') === 'slip' ? 'slip' : 'invoice';
  const ids = (params.get('ids') ?? '')
    .split(',')
    .filter((id) => /^[a-f0-9]{24}$/i.test(id))
    .slice(0, 50);
  const q = useQuery({
    queryKey: ['org', org.id, 'commerce', 'print', ids.join(',')],
    queryFn: () => api<PrintBundle>(`/orgs/${org.id}/orders/print`, { body: { ids } }),
    enabled: ids.length > 0,
  });
  if (!ids.length) return <EmptyState title="No orders chosen to print" />;
  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.isError) return <PageError error={q.error} onRetry={() => void q.refetch()} />;
  const bundle = q.data;
  return (
    <div className="grid gap-6 print:block">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link
            href={ids.length === 1 ? `/app/${org.id}/orders/${ids[0]}` : `/app/${org.id}/orders`}
          >
            Back
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <Segmented<Doc>
            label="Document"
            value={doc}
            onChange={(d) =>
              router.replace(`/app/${org.id}/orders/print?doc=${d}&ids=${ids.join(',')}`)
            }
            options={[
              { value: 'invoice', label: 'Invoice' },
              { value: 'slip', label: 'Packing slip' },
            ]}
          />
          <Button onClick={() => window.print()}>
            <Printer /> Print {bundle.orders.length > 1 ? `${bundle.orders.length} pages` : ''}
          </Button>
        </div>
      </div>
      {bundle.orders.length === 0 ? (
        <EmptyState title="These orders were not found" />
      ) : (
        bundle.orders.map((o) =>
          doc === 'invoice' ? (
            <Invoice key={o.id} o={o} bundle={bundle} />
          ) : (
            <PackingSlip key={o.id} o={o} bundle={bundle} />
          ),
        )
      )}
    </div>
  );
}

export default function PrintOrdersPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <PrintView />
    </Suspense>
  );
}
