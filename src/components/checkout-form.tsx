'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useCart } from '@/lib/cart';
import { cartToken, setCartToken, storeCartTokenKey, useCartCapture } from '@/lib/cart-capture';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/money';
import { firstPick, paymentBody, payingNow, validPick, type PaymentPick } from '@/lib/payments';
import { asciiDigits, isBdMobile } from '@/lib/phone';
import { fieldErrors, readJson } from '@/lib/problem';
import type { PaymentStart } from '@/lib/types';
import { reportStep, storeAttribution } from '@/lib/shop-steps';
import {
  DETAILS_KEY,
  load,
  noSubscribe,
  parseDetails,
  readRaw,
  save,
  type Details,
} from '@/lib/shopper';
import { useAdTags } from './ad-tags';
import { useQuote } from './cart-view';
import { PaymentChoice } from './payment-choice';
import { useShop } from './shop-context';

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

const inputClass =
  'h-11 w-full rounded-store border border-line bg-surface px-3 text-ink placeholder:text-muted aria-invalid:border-red-600';

export function CheckoutForm() {
  const { storeId, language, currency, state, checkoutNote, t } = useShop();
  const cart = useCart(storeId);
  const router = useRouter();
  const formId = useId();
  // Details from the last order on this device fill the form until the shopper types.
  const savedRaw = useSyncExternalStore(
    noSubscribe,
    () => readRaw(DETAILS_KEY),
    () => null,
  );
  const saved = useMemo(() => parseDetails(savedRaw), [savedRaw]);
  const [edited, setEdited] = useState<Details | null>(null);
  const details = edited ?? saved;
  const [note, setNote] = useState('');
  const [chosenZone, setChosenZone] = useState<string | null | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  // The store's numbers: shoppers who opened the checkout (once a day, counted by the API).
  useEffect(() => {
    if (state === 'open') reportStep('checkout');
  }, [state]);
  // The business's ad tags: the checkout started, once the cart is known (ADR 0030).
  const ads = useAdTags();
  const checkoutReported = useRef(false);
  useEffect(() => {
    if (checkoutReported.current || !cart.items.length) return;
    checkoutReported.current = true;
    ads.track(
      'InitiateCheckout',
      cart.items.map((i) => ({
        productId: i.productId,
        variantId: i.variantId,
        name: i.name,
        quantity: i.quantity,
        priceMinor: i.priceMinor,
      })),
    );
  }, [ads, cart.items]);
  const [placing, setPlacing] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const { quote, error: quoteError } = useQuote(cart.items, chosenZone);
  // Until the shopper picks an area, the shop's default area applies.
  const zoneId = chosenZone !== undefined ? chosenZone : (quote?.zoneId ?? null);
  const setZoneId = (id: string) => setChosenZone(id);
  const money = (minor: number) => formatMoney(minor, quote?.currency ?? currency, language);
  const [rawPick, setPick] = useState<PaymentPick | null>(null);
  // Kept valid as the quote changes: a gateway the shop switched off is never sent.
  const pick = validPick(rawPick ?? firstPick(quote?.payments), quote?.payments);
  const payNow = quote ? payingNow(pick, quote.payments, quote.totalMinor) : 0;

  const cartHash = useMemo(
    () => JSON.stringify(cart.items.map((i) => [i.variantId, i.quantity])),
    [cart.items],
  );

  // With reminders on, the cart is saved once the number is valid (and again as it changes).
  const tokenKey = storeCartTokenKey(storeId);
  const phoneDigits = asciiDigits(details.phone).replace(/[\s-]/g, '');
  useCartCapture(
    '/api/carts',
    tokenKey,
    quote?.cartReminders && state === 'open' && isBdMobile(details.phone) && cart.items.length
      ? {
          items: cart.items.map((i) => ({
            productId: i.productId,
            variantId: i.variantId,
            quantity: i.quantity,
          })),
          customer: { name: details.name.trim().slice(0, 80), phone: phoneDigits },
        }
      : null,
  );

  const set = (key: keyof Details) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setEdited({ ...details, [key]: e.target.value });

  const validate = (): Record<string, string> => {
    const out: Record<string, string> = {};
    if (details.name.trim().length < 2) out['customer.name'] = t.required;
    if (!isBdMobile(details.phone)) out['customer.phone'] = t.invalidPhone;
    if (details.line1.trim().length < 4) out['address.line1'] = t.required;
    if (quote?.zones.length && !zoneId) out.zoneId = t.chooseArea;
    return out;
  };

  /** One key per cart: a retry after a lost answer cannot place the order twice. */
  const idempotencyKey = () => {
    const stored = load<{ hash: string; key: string }>(`sl_checkout_${storeId}`, 'session');
    if (stored?.hash === cartHash) return stored.key;
    const key = crypto.randomUUID().replace(/-/g, '');
    save(`sl_checkout_${storeId}`, { hash: cartHash, key }, 'session');
    return key;
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (placing || state === 'preview') return;
    const found = validate();
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) {
      document.getElementById(`${formId}-${Object.keys(found)[0]}`)?.focus();
      return;
    }
    setPlacing(true);
    const website = (new FormData(e.currentTarget).get('website') as string | null) ?? '';
    const payload = {
      items: cart.items.map((i) => ({
        productId: i.productId,
        variantId: i.variantId,
        quantity: i.quantity,
      })),
      customer: {
        name: details.name.trim(),
        phone: asciiDigits(details.phone).replace(/[\s-]/g, ''),
        ...(details.email.trim() ? { email: details.email.trim() } : {}),
      },
      address: {
        line1: details.line1.trim(),
        ...(details.area.trim() ? { area: details.area.trim() } : {}),
        ...(details.city.trim() ? { city: details.city.trim() } : {}),
        ...(details.district.trim() ? { district: details.district.trim() } : {}),
      },
      zoneId: zoneId ?? null,
      ...(paymentBody(pick, quote?.payments)
        ? { payment: paymentBody(pick, quote?.payments) }
        : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(website ? { website } : {}),
      // Where the shopper came from (the ad or site), kept on the order.
      ...(state === 'open' && storeAttribution() ? { attribution: storeAttribution() } : {}),
      // The ad tags' cookies and page, for the purchase the server reports (ADR 0030).
      ...(ads.ids() ? { tracking: ads.ids() } : {}),
    };
    // The saved cart this order comes from, if one was saved; the order closes it.
    const token = cartToken(tokenKey, false);
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
        body: JSON.stringify({ ...payload, ...(token ? { cartToken: token } : {}) }),
      });
      const r = await readJson<{
        orderNumber: string;
        receipt: string;
        payment: PaymentStart | null;
      }>(res, t);
      if (r.ok) {
        save(DETAILS_KEY, { ...details, email: '' }, 'local');
        setCartToken(tokenKey, null);
        save(`sl_checkout_${storeId}`, null, 'session');
        cart.clear();
        const paying = r.data.payment;
        // Off to the gateway's own page; it sends the shopper back to the receipt.
        if (paying?.redirectUrl) {
          setRedirecting(true);
          window.location.assign(paying.redirectUrl);
          return;
        }
        router.replace(
          `/order?receipt=${encodeURIComponent(r.data.receipt)}&new=1${paying ? '&payment=unstarted' : ''}`,
        );
        return;
      }
      const fields = fieldErrors(r.problem);
      setErrors(fields);
      setFormError(r.problem.code === 'cart_changed' ? t.fixCart : r.problem.detail);
    } catch {
      setFormError(t.tryAgain);
    }
    setPlacing(false);
  };

  if (!cart.items.length)
    return (
      <div className="rounded-store-lg border border-dashed border-line p-12 text-center">
        <p className="text-muted">{t.cartEmpty}</p>
        <Link href="/products" className="mt-4 inline-block text-primary underline">
          {t.continueShopping}
        </Link>
      </div>
    );

  const fid = (path: string) => `${formId}-${path}`;
  const invalid = (path: string) =>
    errors[path] ? { 'aria-invalid': true, 'aria-describedby': `${fid(path)}-error` } : {};

  return (
    <form onSubmit={submit} noValidate className="grid gap-8 lg:grid-cols-[1fr_360px]">
      <div className="space-y-8">
        <section className="space-y-4 rounded-store-lg border border-line bg-surface p-5">
          <h2 className="font-semibold">{t.yourDetails}</h2>
          <Field id={fid('customer.name')} label={t.name} error={errors['customer.name']}>
            <input
              id={fid('customer.name')}
              autoComplete="name"
              value={details.name}
              onChange={set('name')}
              className={inputClass}
              {...invalid('customer.name')}
            />
          </Field>
          <Field
            id={fid('customer.phone')}
            label={t.phone}
            error={errors['customer.phone']}
            hint={quote?.cartReminders ? `${t.phoneHint} ${t.cartReminderNotice}` : t.phoneHint}
          >
            <input
              id={fid('customer.phone')}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="01XXXXXXXXX"
              value={details.phone}
              onChange={set('phone')}
              className={inputClass}
              {...invalid('customer.phone')}
            />
          </Field>
          <Field id={fid('customer.email')} label={t.email} error={errors['customer.email']}>
            <input
              id={fid('customer.email')}
              type="email"
              autoComplete="email"
              value={details.email}
              onChange={set('email')}
              className={inputClass}
              {...invalid('customer.email')}
            />
          </Field>
        </section>

        <section className="space-y-4 rounded-store-lg border border-line bg-surface p-5">
          <h2 className="font-semibold">{t.address}</h2>
          <Field id={fid('address.line1')} label={t.addressLine} error={errors['address.line1']}>
            <input
              id={fid('address.line1')}
              autoComplete="street-address"
              value={details.line1}
              onChange={set('line1')}
              className={inputClass}
              {...invalid('address.line1')}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={fid('address.area')} label={t.area}>
              <input
                id={fid('address.area')}
                value={details.area}
                onChange={set('area')}
                className={inputClass}
              />
            </Field>
            <Field id={fid('address.city')} label={t.city}>
              <input
                id={fid('address.city')}
                autoComplete="address-level2"
                value={details.city}
                onChange={set('city')}
                className={inputClass}
              />
            </Field>
            <Field id={fid('address.district')} label={t.district}>
              <input
                id={fid('address.district')}
                autoComplete="address-level1"
                value={details.district}
                onChange={set('district')}
                className={inputClass}
              />
            </Field>
          </div>
          {quote?.zones.length ? (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{t.deliveryArea}</legend>
              <div className="grid gap-2 sm:grid-cols-2" id={fid('zoneId')} tabIndex={-1}>
                {quote.zones.map((z) => (
                  <label
                    key={z.id}
                    className={cn(
                      'flex cursor-pointer items-center justify-between gap-3 rounded-store border p-3 text-sm',
                      zoneId === z.id ? 'border-primary bg-tint' : 'border-line',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="zone"
                        value={z.id}
                        checked={zoneId === z.id}
                        onChange={() => setZoneId(z.id)}
                        className="accent-(--primary)"
                      />
                      {z.name}
                    </span>
                    <span className="font-medium">{money(z.chargeMinor)}</span>
                  </label>
                ))}
              </div>
              {errors.zoneId ? <p className="mt-1 text-sm text-red-700">{errors.zoneId}</p> : null}
            </fieldset>
          ) : null}
          <div>
            <label htmlFor={fid('note')} className="mb-1.5 block text-sm font-medium">
              {t.note}
            </label>
            <textarea
              id={fid('note')}
              rows={3}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-store border border-line bg-surface p-3 text-ink"
            />
          </div>
          {/* Left empty by people; bots fill every field. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
            <label>
              Website
              <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
            </label>
          </div>
        </section>

        <section className="space-y-3 rounded-store-lg border border-line bg-surface p-5">
          <h2 className="font-semibold">{t.payment}</h2>
          <PaymentChoice
            id={fid('payment')}
            options={quote?.payments}
            pick={pick}
            onPick={setPick}
            money={money}
            t={t}
            error={errors['payment.gateway'] ?? errors['payment.method']}
          />
        </section>
      </div>

      <aside className="h-fit space-y-4 rounded-store-lg border border-line bg-surface p-5 lg:sticky lg:top-6">
        <h2 className="font-semibold">{t.orderSummary}</h2>
        <ul className="space-y-3">
          {cart.items.map((item) => {
            const line = quote?.lines.find((l) => l.variantId === item.variantId);
            return (
              <li key={item.variantId} className="flex gap-3 text-sm">
                <div className="size-12 shrink-0 overflow-hidden rounded-store bg-tint">
                  {item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.image} alt="" className="size-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 font-medium">{line?.name ?? item.name}</p>
                  <p className="text-muted">
                    {item.variantTitle ? `${item.variantTitle} · ` : ''}× {item.quantity}
                  </p>
                  {line?.problem ? (
                    <p className="text-red-700">{t.lineProblem[line.problem]}</p>
                  ) : null}
                </div>
                <p className="shrink-0">
                  {money(line?.totalMinor ?? item.priceMinor * item.quantity)}
                </p>
              </li>
            );
          })}
        </ul>
        <dl className="space-y-2 border-t border-line pt-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">{t.subtotal}</dt>
            <dd>{quote ? money(quote.subtotalMinor) : '…'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">{t.delivery}</dt>
            <dd>
              {!quote ? (
                '…'
              ) : quote.zones.length && !zoneId ? (
                <span className="text-muted">{t.chooseArea}</span>
              ) : (
                money(quote.deliveryChargeMinor)
              )}
            </dd>
          </div>
          <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
            <dt>{t.total}</dt>
            <dd>{quote ? money(quote.totalMinor) : '…'}</dd>
          </div>
          {quote && payNow > 0 ? (
            <>
              <div className="flex justify-between">
                <dt className="text-muted">{t.payNowLabel}</dt>
                <dd className="font-medium">{money(payNow)}</dd>
              </div>
              {quote.totalMinor > payNow ? (
                <div className="flex justify-between">
                  <dt className="text-muted">{t.payOnDelivery}</dt>
                  <dd>{money(quote.totalMinor - payNow)}</dd>
                </div>
              ) : null}
            </>
          ) : null}
        </dl>
        {quote?.belowMinimum ? (
          <p className="text-sm text-red-700">{t.minimumOrder(money(quote.minOrderMinor))}</p>
        ) : null}
        {checkoutNote ? <p className="text-sm text-muted">{checkoutNote}</p> : null}
        {state === 'preview' ? (
          <p className="rounded-store bg-ink p-3 text-sm text-white">{t.previewNoOrders}</p>
        ) : null}
        {formError || quoteError ? (
          <p className="text-sm font-medium text-red-700" role="alert">
            {formError ?? quoteError}{' '}
            {formError === t.fixCart ? (
              <Link href="/cart" className="underline">
                {t.cart}
              </Link>
            ) : null}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={placing || state === 'preview' || !quote || quote.belowMinimum}
          className="flex h-12 w-full items-center justify-center rounded-store bg-primary font-semibold text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {redirecting
            ? t.goingToPay
            : placing
              ? t.placing
              : payNow > 0
                ? t.placeAndPay(money(payNow))
                : t.placeOrder}
        </button>
      </aside>
    </form>
  );
}
