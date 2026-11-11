import { CheckCircle2, Phone } from 'lucide-react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { AdPurchase, AdTagsProvider } from '@/components/ad-tags';
import { OrderProgress } from '@/components/order-status';
import { PayNow } from '@/components/pay-now';
import { PaymentBanner, PaymentRows } from '@/components/payment-summary';
import { ApiError, apiGet, contextFrom } from '@/lib/api';
import { dictionary } from '@/lib/i18n';
import { isLandingSlug } from '@/lib/landing-offer';
import { formatMoney } from '@/lib/money';
import { isReturnState } from '@/lib/payments';
import type { LandingReceipt } from '@/lib/types';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The thank-you page after a landing page order: the order as the shop received it. The
 * signed receipt in the address is the only key; it works while the page is paused too.
 */
export default async function LandingThanks({ params, searchParams }: Props) {
  const { slug } = await params;
  const q = await searchParams;
  const token = typeof q.receipt === 'string' ? q.receipt : '';
  if (!isLandingSlug(slug) || token.length < 10 || token.length > 400) notFound();
  let data: LandingReceipt;
  try {
    data = await apiGet<LandingReceipt>(
      `/landing-pages/${slug}/receipt?receipt=${encodeURIComponent(token)}`,
      contextFrom(await headers(), undefined),
    );
  } catch (err) {
    if (err instanceof ApiError && (err.problem.status === 404 || err.problem.status === 422))
      notFound();
    throw err;
  }
  const { order, store, page } = data;
  const language = page.language;
  const t = dictionary(language);
  const money = (minor: number) => formatMoney(minor, order.currency, language);
  const returned = isReturnState(q.payment) ? q.payment : null;

  return (
    <AdTagsProvider
      tags={data.tracking}
      endpoint={`/api/landing/${encodeURIComponent(page.slug)}/ad-events`}
      currency={order.currency}
      language={language}
    >
      <main id="main" className="mx-auto max-w-2xl px-4 py-10">
        {/* The purchase for the business's ad tags, once, on the day it was placed (ADR 0030). */}
        <AdPurchase purchase={order.tracking?.purchase} placedAt={order.placedAt} />
        <PaymentBanner order={order} state={returned} t={t} />
        <div className="rounded-store-lg border border-line bg-surface p-6 text-center">
          <CheckCircle2 className="mx-auto size-14 text-primary" aria-hidden="true" />
          <h1 className="mt-3 font-display text-2xl font-bold">{t.thanks}</h1>
          <p className="mt-2 text-lg">{t.orderPlaced(order.number)}</p>
          {q.again === '1' ? <p className="mt-2 text-sm text-muted">{t.thanksAgain}</p> : null}
          <p className="mt-2 text-muted">{t.weWillCall}</p>
          {store.contact.phone ? (
            <a
              href={`tel:${store.contact.phone}`}
              className="mt-5 inline-flex h-11 items-center gap-2 rounded-store border-2 border-primary px-5 font-semibold text-primary"
            >
              <Phone className="size-4" aria-hidden="true" /> {t.callShop}
            </a>
          ) : null}
          <p className="mt-4 text-xs text-muted">{t.saveLink}</p>
        </div>

        {order.payment?.payNow ? (
          <div className="mt-6">
            <PayNow
              receipt={token}
              payment={order.payment}
              endpoint={`/api/landing/${encodeURIComponent(page.slug)}/pay`}
              currency={order.currency}
              language={language}
            />
          </div>
        ) : null}

        <section className="mt-6 rounded-store-lg border border-line bg-surface p-5">
          <h2 className="mb-3 font-semibold">{t.items}</h2>
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
                    {i.variantTitle && i.variantTitle !== 'Default' ? `${i.variantTitle} · ` : ''}×{' '}
                    {i.quantity}
                  </p>
                </div>
                <p>{money(i.totalMinor)}</p>
              </li>
            ))}
          </ul>
          <dl className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
            {order.discountMinor > 0 ? (
              <div className="flex justify-between text-primary">
                <dt>{t.youSave(money(order.discountMinor))}</dt>
                <dd>−{money(order.discountMinor)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between">
              <dt className="text-muted">
                {t.delivery}
                {order.deliveryZone ? ` (${order.deliveryZone})` : ''}
              </dt>
              <dd>{order.deliveryChargeMinor ? money(order.deliveryChargeMinor) : t.free}</dd>
            </div>
            <div className="flex justify-between text-base font-semibold">
              <dt>{t.total}</dt>
              <dd>{money(order.totalMinor)}</dd>
            </div>
            <PaymentRows order={order} t={t} money={money} />
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

        <section className="mt-6 rounded-store-lg border border-line bg-surface p-5">
          <h2 className="mb-4 font-semibold">{t.status}</h2>
          <OrderProgress
            status={order.status}
            timeline={order.timeline}
            shipment={order.shipment}
            language={language}
            t={t}
          />
        </section>

        <p className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm font-medium">
          <a href={`/${page.slug}`} className="text-primary hover:underline">
            {t.backToOffer}
          </a>
          {store.open ? (
            <a href={store.url} className="text-primary hover:underline">
              {t.visitShop}
            </a>
          ) : null}
        </p>
      </main>
    </AdTagsProvider>
  );
}
