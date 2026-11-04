import { CheckCircle2, LinkIcon } from 'lucide-react';
import Link from 'next/link';
import { callApi, getStore, shopContext } from '@/lib/api';
import type { CartItem } from '@/lib/cart-lines';
import { cartStorageKey, landingCartTokenKey, storeCartTokenKey } from '@/lib/cart-keys';
import { dictionary } from '@/lib/i18n';
import { isOpen, type Language, type Quote, type RestoredCart } from '@/lib/types';
import { RestoreCart, type RestorePlan } from './restore';

export const dynamic = 'force-dynamic';

function Notice({
  language,
  title,
  text,
  done,
}: {
  language: Language;
  title: string;
  text: string;
  done?: boolean;
}) {
  const t = dictionary(language);
  const Icon = done ? CheckCircle2 : LinkIcon;
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-store-lg border border-line bg-surface p-8 text-center shadow-sm">
        <Icon className="mx-auto mb-4 size-10 text-primary" aria-hidden="true" />
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted">{text}</p>
        <Link
          href="/"
          className="mt-6 inline-flex h-11 items-center rounded-store bg-primary px-5 font-medium text-on-primary"
        >
          {t.visitShop}
        </Link>
      </div>
    </main>
  );
}

/**
 * A cart reminder's link (`<store>/r/<code>`): puts the cart back in this browser and
 * opens the checkout, or the landing page with the same choice. The code only works on the
 * store the cart belongs to.
 */
export default async function RestorePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const store = await getStore();
  const language = store?.language ?? 'en';
  const t = dictionary(language);
  const invalid = (
    <Notice language={language} title={t.restoreInvalid} text={t.restoreInvalidText} />
  );
  if (!store || store.state === 'unavailable' || !/^[A-Za-z0-9]{10}$/.test(code)) return invalid;

  const ctx = await shopContext();
  const found = await callApi(ctx, `/carts/${code}`);
  if (found.status !== 200) return invalid;
  const cart = found.body as RestoredCart;
  if (cart.status === 'ordered')
    return <Notice language={language} title={t.restoreOrdered} text={t.restoreOrderedText} done />;

  let plan: RestorePlan;
  if (cart.kind === 'landing_page' && cart.landingPage) {
    const slug = cart.landingPage.slug;
    const s = cart.selection;
    const q = new URLSearchParams({ cart: '1' });
    if (s?.packageId) q.set('pkg', s.packageId);
    if (s?.variantId) q.set('v', s.variantId);
    if (s && !s.packageId) q.set('q', String(s.quantity));
    if (s?.addOn) q.set('addon', '1');
    plan = {
      to: `/${slug}?${q.toString()}#order`,
      cart: null,
      token: cart.token ? { key: landingCartTokenKey(slug), value: cart.token } : null,
      customer: cart.customer,
    };
  } else {
    // Priced again now: names, pictures and prices as the shop shows them today.
    let items: CartItem[] = [];
    if (isOpen(store) && cart.items.length) {
      const priced = await callApi(ctx, '/cart', { method: 'POST', body: { items: cart.items } });
      if (priced.status === 200)
        items = (priced.body as Quote).lines.flatMap((l) =>
          l.problem === 'unavailable' || !l.name
            ? []
            : [
                {
                  productId: l.productId,
                  variantId: l.variantId,
                  quantity: l.quantity,
                  slug: l.slug ?? '',
                  name: l.name,
                  variantTitle: l.variantTitle ?? '',
                  image: l.image ?? null,
                  priceMinor: l.unitPriceMinor ?? 0,
                },
              ],
        );
    }
    plan = {
      to: items.length ? '/checkout' : '/',
      cart: items.length ? { key: cartStorageKey(store.id), items } : null,
      token: cart.token ? { key: storeCartTokenKey(store.id), value: cart.token } : null,
      customer: cart.customer,
    };
  }
  return <RestoreCart plan={plan} label={t.restoringCart} open={t.restoreOpen} />;
}
