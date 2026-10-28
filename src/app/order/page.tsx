import { CheckCircle2 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrderProgress } from '@/components/order-status';
import { ApiError, apiGet } from '@/lib/api';
import { dictionary } from '@/lib/i18n';
import { formatDate, formatMoney } from '@/lib/money';
import { openStore } from '@/lib/page-store';
import type { Receipt } from '@/lib/types';

export async function generateMetadata(): Promise<Metadata> {
  const store = await openStore();
  return {
    title: dictionary(store.language).orderSummary,
    robots: { index: false, follow: false },
  };
}

export default async function OrderPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const store = await openStore();
  const t = dictionary(store.language);
  const params = await searchParams;
  const token = typeof params.receipt === 'string' ? params.receipt : '';
  if (token.length < 10 || token.length > 400) notFound();
  let order: Receipt;
  try {
    order = await apiGet<Receipt>(`/orders/receipt?receipt=${encodeURIComponent(token)}`);
  } catch (err) {
    if (err instanceof ApiError && (err.problem.status === 404 || err.problem.status === 422))
      notFound();
    throw err;
  }
  const money = (minor: number) => formatMoney(minor, order.currency, store.language);
  const isNew = params.new === '1';

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      {isNew ? (
        <div className="mb-8 rounded-store-lg border border-line bg-surface p-6 text-center">
          <CheckCircle2 className="mx-auto size-12 text-primary" aria-hidden="true" />
          <h1 className="mt-3 text-2xl font-semibold">{t.thanks}</h1>
          <p className="mt-2">{t.orderPlaced(order.number)}</p>
          <p className="mt-1 text-sm text-muted">{t.weWillCall}</p>
          <p className="mt-3 text-xs text-muted">{t.saveLink}</p>
        </div>
      ) : (
        <h1 className="mb-6 text-2xl font-semibold">
          {t.orderNumber} {order.number}
        </h1>
      )}

      <div className="grid gap-6 md:grid-cols-[1fr_280px]">
        <section className="rounded-store-lg border border-line bg-surface p-5">
          <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted">{t.orderNumber}</dt>
              <dd className="font-semibold">{order.number}</dd>
            </div>
            <div>
              <dt className="text-muted">{t.placedOn}</dt>
              <dd>{formatDate(order.placedAt, store.language)}</dd>
            </div>
          </dl>
          <h2 className="mb-3 border-t border-line pt-4 font-semibold">{t.items}</h2>
          <ul className="space-y-3">
            {order.items.map((i, n) => (
              <li key={n} className="flex gap-3 text-sm">
                <div className="size-14 shrink-0 overflow-hidden rounded-store bg-tint">
                  {i.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={i.image} alt="" className="size-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{i.name}</p>
                  <p className="text-muted">
                    {i.variantTitle ? `${i.variantTitle} · ` : ''}
                    {money(i.unitPriceMinor)} × {i.quantity}
                  </p>
                </div>
                <p>{money(i.totalMinor)}</p>
              </li>
            ))}
          </ul>
          <dl className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">{t.subtotal}</dt>
              <dd>{money(order.subtotalMinor)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">
                {t.delivery}
                {order.deliveryZone ? ` (${order.deliveryZone})` : ''}
              </dt>
              <dd>{money(order.deliveryChargeMinor)}</dd>
            </div>
            <div className="flex justify-between text-base font-semibold">
              <dt>{t.total}</dt>
              <dd>{money(order.totalMinor)}</dd>
            </div>
            <div className="flex justify-between text-muted">
              <dt>{t.payment}</dt>
              <dd>{order.paymentMethod === 'cod' ? t.cod : order.paymentMethod}</dd>
            </div>
          </dl>
          <div className="mt-4 border-t border-line pt-4 text-sm">
            <p className="text-muted">{t.shipTo}</p>
            <p className="font-medium">
              {order.customer.name}
              {order.customer.phone ? ` · ${order.customer.phone}` : ''}
            </p>
            <p>
              {[order.address.line1, order.address.area, order.address.city, order.address.district]
                .filter(Boolean)
                .join(', ')}
            </p>
          </div>
        </section>
        <aside className="h-fit rounded-store-lg border border-line bg-surface p-5">
          <h2 className="mb-4 font-semibold">{t.status}</h2>
          <OrderProgress
            status={order.status}
            timeline={order.timeline}
            shipment={order.shipment}
            language={store.language}
            t={t}
          />
        </aside>
      </div>
      <p className="mt-8 text-center">
        <Link href="/products" className="text-sm font-medium text-primary hover:underline">
          {t.continueShopping}
        </Link>
      </p>
    </div>
  );
}
