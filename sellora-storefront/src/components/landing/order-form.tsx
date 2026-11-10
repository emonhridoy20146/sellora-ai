'use client';

import { Minus, Plus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState, useSyncExternalStore } from 'react';
import { cartToken, landingCartTokenKey, setCartToken, useCartCapture } from '@/lib/cart-capture';
import { cn } from '@/lib/cn';
import { dictionary } from '@/lib/i18n';
import {
  attributionKey,
  firstAvailable,
  offerTotals,
  packageCharge,
  restoredChoice,
  variantFor,
} from '@/lib/landing-offer';
import { formatMoney, formatNumber } from '@/lib/money';
import {
  firstPick,
  landingOptions,
  paymentBody,
  payingNow,
  validPick,
  type PaymentPick,
} from '@/lib/payments';
import { asciiDigits, isBdMobile } from '@/lib/phone';
import { fieldErrors, readJson } from '@/lib/problem';
import { DETAILS_KEY, load, noSubscribe, parseDetails, readRaw, save } from '@/lib/shopper';
import type {
  Attribution,
  DeliveryZone,
  Language,
  LandingAddOnOffer,
  LandingPackage,
  LandingPayments,
  LandingPlaced,
  LandingProduct,
} from '@/lib/types';
import { PaymentChoice } from '../payment-choice';

const inputClass =
  'h-12 w-full rounded-store border border-line bg-surface px-3 text-base text-ink placeholder:text-muted aria-invalid:border-red-600';

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
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold">
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

export interface LandingOrderFormProps {
  slug: string;
  pageId: string;
  preview: boolean;
  language: Language;
  currency: string;
  product: LandingProduct;
  packages: LandingPackage[];
  maxFreeQuantity: number;
  addOn: LandingAddOnOffer | null;
  noteField: boolean;
  zones: DeliveryZone[];
  defaultZoneId: string | null;
  buttonLabel: string;
  /** The business texts reminders about orders left with a phone number. */
  cartReminders: boolean;
  /** How shoppers may pay; without it, cash on delivery only. */
  payments?: LandingPayments | undefined;
}

/**
 * The page's order form: package, option, add-on, name, phone, address and delivery area,
 * paid in cash on delivery (perhaps with an advance) or online. Totals here are for the
 * shopper to read; the API prices the order again from the published page and refuses
 * anything that does not match it.
 */
export function LandingOrderForm(props: LandingOrderFormProps) {
  const { slug, pageId, preview, language, currency, product, packages, addOn, zones } = props;
  const t = dictionary(language);
  const router = useRouter();
  const formId = useId();
  const money = (minor: number) => formatMoney(minor, currency, language);
  const num = (n: number) => formatNumber(n, language);

  const savedRaw = useSyncExternalStore(
    noSubscribe,
    () => readRaw(DETAILS_KEY),
    () => null,
  );
  const saved = useMemo(() => parseDetails(savedRaw), [savedRaw]);
  const [edited, setEdited] = useState<{ name: string; phone: string; line1: string } | null>(null);
  const details = edited ?? { name: saved.name, phone: saved.phone, line1: saved.line1 };

  const searchParams = useSearchParams();
  const [restored] = useState(() => restoredChoice(new URLSearchParams(searchParams), props));
  // A package with a badge ("Most popular") is the one most shoppers pick: start there.
  const [packageId, setPackageId] = useState<string | null>(
    restored?.packageId ?? (packages.find((p) => p.badge) ?? packages[0])?.id ?? null,
  );
  const [chosen, setChosen] = useState<(string | undefined)[]>(
    () => restored?.optionValues ?? firstAvailable(product)?.optionValues ?? [],
  );
  const [quantity, setQuantity] = useState(restored?.quantity ?? 1);
  const [withAddOn, setWithAddOn] = useState(restored?.addOn ?? false);
  const [chosenZone, setChosenZone] = useState<string | null>(null);
  const zoneId = chosenZone ?? props.defaultZoneId ?? (zones.length === 1 ? zones[0]!.id : null);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);

  const variant = variantFor(product, chosen);
  const pkg = packages.find((p) => p.id === packageId);
  const totals = offerTotals(props, {
    packageId,
    variantId: variant?.id ?? null,
    quantity,
    addOn: withAddOn,
    zoneId,
  });
  const options = landingOptions(props.payments, {
    totalMinor: totals?.totalMinor ?? 0,
    deliveryChargeMinor: totals?.deliveryMinor ?? 0,
    zoneId: zones.length ? zoneId : null,
  });
  const [rawPick, setPick] = useState<PaymentPick | null>(null);
  const pick = validPick(rawPick ?? firstPick(options), options);
  const payNow = totals ? payingNow(pick, options, totals.totalMinor) : 0;
  const [redirecting, setRedirecting] = useState(false);
  const maxQty = Math.min(props.maxFreeQuantity, variant?.maxQuantity ?? props.maxFreeQuantity);
  const wanted = pkg ? pkg.quantity : quantity;
  const stockProblem = !variant
    ? null
    : !variant.available
      ? t.outOfStock
      : variant.maxQuantity !== null && wanted > variant.maxQuantity
        ? t.onlyLeft(num(variant.maxQuantity))
        : null;

  const fid = (path: string) => `${formId}-${path}`;
  const invalid = (path: string) =>
    errors[path] ? { 'aria-invalid': true, 'aria-describedby': `${fid(path)}-error` } : {};
  const setDetail = (key: 'name' | 'phone' | 'line1') => (value: string) =>
    setEdited({ ...details, [key]: value });

  const validate = (): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!variant) out.variantId = t.chooseOption(product.options[0]?.name ?? '');
    if (packages.length && !pkg) out.packageId = t.choosePackage;
    if (details.name.trim().length < 2) out['customer.name'] = t.required;
    if (!isBdMobile(details.phone)) out['customer.phone'] = t.invalidPhone;
    if (details.line1.trim().length < 4) out['address.line1'] = t.required;
    if (zones.length && !zoneId) out.zoneId = t.chooseArea;
    return out;
  };

  const payload = () => ({
    packageId: packages.length ? packageId : null,
    variantId: variant!.id,
    ...(packages.length ? {} : { quantity }),
    addOn: Boolean(addOn && withAddOn),
    customer: {
      name: details.name.trim(),
      phone: asciiDigits(details.phone).replace(/[\s-]/g, ''),
    },
    address: { line1: details.line1.trim() },
    zoneId: zones.length ? zoneId : null,
    ...(props.noteField && note.trim() ? { note: note.trim() } : {}),
    ...(paymentBody(pick, options) ? { payment: paymentBody(pick, options) } : {}),
  });

  /** One key per order as filled in: a retry after a lost answer cannot order twice. */
  const idempotencyKey = (hash: string) => {
    const stored = load<{ hash: string; key: string }>(`sl_lp_${pageId}`, 'session');
    if (stored?.hash === hash) return stored.key;
    const key = crypto.randomUUID().replace(/-/g, '');
    save(`sl_lp_${pageId}`, { hash, key }, 'session');
    return key;
  };

  // With reminders on, the choice is saved once the number is valid (and again as it changes).
  const tokenKey = landingCartTokenKey(slug);
  useCartCapture(
    `/api/landing/${encodeURIComponent(slug)}/carts`,
    tokenKey,
    props.cartReminders && !preview && variant && isBdMobile(details.phone)
      ? {
          packageId: packages.length ? packageId : null,
          variantId: variant.id,
          quantity: packages.length ? (pkg?.quantity ?? 1) : quantity,
          addOn: Boolean(addOn && withAddOn),
          customer: {
            name: details.name.trim().slice(0, 80),
            phone: asciiDigits(details.phone).replace(/[\s-]/g, ''),
          },
        }
      : null,
  );

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (placing || preview) return;
    const found = validate();
    setErrors(found);
    setFormError(stockProblem);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(fid(first))?.focus();
      return;
    }
    if (stockProblem) return;
    setPlacing(true);
    const body = payload();
    const website = (new FormData(e.currentTarget).get('website') as string | null) ?? '';
    const attribution = load<Attribution>(attributionKey(pageId), 'session');
    // The saved cart this order comes from, if one was saved; the order closes it.
    const token = cartToken(tokenKey, false);
    try {
      const res = await fetch(`/api/landing/${encodeURIComponent(slug)}/order`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey(JSON.stringify(body)),
        },
        body: JSON.stringify({
          ...body,
          ...(website ? { website } : {}),
          ...(attribution && Object.keys(attribution).length ? { attribution } : {}),
          ...(token ? { cartToken: token } : {}),
        }),
      });
      const r = await readJson<LandingPlaced>(res, t);
      if (r.ok) {
        save(
          DETAILS_KEY,
          { ...saved, name: body.customer.name, phone: details.phone, line1: body.address.line1 },
          'local',
        );
        save(`sl_lp_${pageId}`, null, 'session');
        setCartToken(tokenKey, null);
        const paying = r.data.payment;
        // Off to the gateway's own page; it sends the shopper back to the thank-you page.
        if (paying?.redirectUrl) {
          setRedirecting(true);
          window.location.assign(paying.redirectUrl);
          return;
        }
        router.replace(
          `/${slug}/thanks?receipt=${encodeURIComponent(r.data.receipt)}${r.data.duplicate ? '&again=1' : ''}${paying ? '&payment=unstarted' : ''}`,
        );
        return;
      }
      const p = r.problem;
      setErrors(fieldErrors(p));
      setFormError(
        p.code === 'not_enough_stock' && typeof p.left === 'number'
          ? t.onlyLeft(num(p.left))
          : p.code === 'out_of_stock'
            ? t.outOfStock
            : p.code === 'offer_not_available'
              ? t.offerUnavailableTitle
              : p.code === 'add_on_unavailable'
                ? t.addOnGone
                : p.detail,
      );
    } catch {
      setFormError(t.tryAgain);
    }
    setPlacing(false);
  };

  // Packages are priced against the option chosen, or the cheapest one to start with.
  const unitMinor = variant?.priceMinor ?? Math.min(...product.variants.map((v) => v.priceMinor));

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      {packages.length ? (
        <fieldset id={fid('packageId')} tabIndex={-1}>
          <legend className="mb-2 text-sm font-semibold">{t.choosePackage}</legend>
          <div className="grid gap-2">
            {packages.map((p) => {
              const c = packageCharge(unitMinor, p.quantity, p.priceMinor);
              const tooMany =
                variant?.maxQuantity !== null &&
                variant?.maxQuantity !== undefined &&
                p.quantity > variant.maxQuantity;
              return (
                <label
                  key={p.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-store-lg border-2 bg-surface p-4',
                    packageId === p.id ? 'border-primary' : 'border-line',
                    tooMany && 'opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name="package"
                    value={p.id}
                    checked={packageId === p.id}
                    onChange={() => setPackageId(p.id)}
                    className="size-5 accent-(--primary)"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold">{p.label}</span>
                    {p.badge ? (
                      <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-on-accent">
                        {p.badge}
                      </span>
                    ) : null}
                    {c.savingMinor > 0 ? (
                      <span className="block text-sm text-primary">
                        {t.youSave(money(c.savingMinor))}
                      </span>
                    ) : null}
                    {tooMany && variant?.maxQuantity !== null ? (
                      <span className="block text-sm text-red-700">
                        {t.onlyLeft(num(variant?.maxQuantity ?? 0))}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-right">
                    <span className="block text-lg font-bold">{money(c.totalMinor)}</span>
                    {c.savingMinor > 0 ? (
                      <span className="text-sm text-muted line-through">
                        {money(c.regularMinor)}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
          {errors.packageId ? (
            <p className="mt-1 text-sm text-red-700">{errors.packageId}</p>
          ) : null}
        </fieldset>
      ) : null}

      {product.variants.length > 1
        ? product.options.map((opt, i) => (
            <fieldset key={opt.name} id={i === 0 ? fid('variantId') : undefined} tabIndex={-1}>
              <legend className="mb-2 text-sm font-semibold">{opt.name}</legend>
              <div className="flex flex-wrap gap-2">
                {opt.values.map((value) => {
                  const next = [...chosen];
                  next[i] = value;
                  const match = variantFor(product, next);
                  const selected = chosen[i] === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setChosen(next)}
                      className={cn(
                        'min-h-11 rounded-store border-2 bg-surface px-4 text-sm font-medium',
                        selected ? 'border-primary' : 'border-line',
                        match && !match.available && 'text-muted line-through',
                      )}
                    >
                      {value}
                    </button>
                  );
                })}
              </div>
              {i === 0 && errors.variantId ? (
                <p className="mt-1 text-sm text-red-700">{errors.variantId}</p>
              ) : null}
            </fieldset>
          ))
        : null}

      {!packages.length ? (
        <div>
          <p className="mb-2 text-sm font-semibold" id={fid('quantity-label')}>
            {t.quantity}
          </p>
          <div
            className="inline-flex items-center rounded-store border border-line bg-surface"
            role="group"
            aria-labelledby={fid('quantity-label')}
          >
            <button
              type="button"
              className="flex size-12 items-center justify-center disabled:opacity-40"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              disabled={quantity <= 1}
              aria-label="−"
            >
              <Minus className="size-4" aria-hidden="true" />
            </button>
            <output className="w-10 text-center font-semibold" aria-live="polite">
              {num(quantity)}
            </output>
            <button
              type="button"
              className="flex size-12 items-center justify-center disabled:opacity-40"
              onClick={() => setQuantity((q) => Math.min(Math.max(1, maxQty), q + 1))}
              disabled={quantity >= maxQty}
              aria-label="+"
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}

      {addOn ? (
        <label
          className={cn(
            'flex cursor-pointer items-center gap-3 rounded-store-lg border-2 border-dashed bg-surface p-4',
            withAddOn ? 'border-primary' : 'border-line',
          )}
        >
          <input
            type="checkbox"
            checked={withAddOn}
            onChange={(e) => setWithAddOn(e.target.checked)}
            className="size-5 accent-(--primary)"
          />
          {addOn.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={addOn.image} alt="" className="size-14 rounded-store object-cover" />
          ) : null}
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold tracking-wide text-primary uppercase">
              {t.addOnTitle}
            </span>
            <span className="font-semibold">{addOn.label}</span>
            {addOn.variantTitle ? (
              <span className="block text-sm text-muted">{addOn.variantTitle}</span>
            ) : null}
          </span>
          <span className="text-right">
            <span className="block font-bold">{money(addOn.priceMinor)}</span>
            {addOn.regularPriceMinor > addOn.priceMinor ? (
              <span className="text-sm text-muted line-through">
                {money(addOn.regularPriceMinor)}
              </span>
            ) : null}
          </span>
        </label>
      ) : null}

      <div className="space-y-4 rounded-store-lg border border-line bg-surface p-5">
        <Field id={fid('customer.name')} label={t.name} error={errors['customer.name']}>
          <input
            id={fid('customer.name')}
            autoComplete="name"
            value={details.name}
            maxLength={80}
            onChange={(e) => setDetail('name')(e.target.value)}
            className={inputClass}
            {...invalid('customer.name')}
          />
        </Field>
        <Field
          id={fid('customer.phone')}
          label={t.phone}
          error={errors['customer.phone']}
          hint={props.cartReminders ? `${t.phoneHint} ${t.cartReminderNotice}` : t.phoneHint}
        >
          <input
            id={fid('customer.phone')}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="01XXXXXXXXX"
            value={details.phone}
            maxLength={20}
            onChange={(e) => setDetail('phone')(e.target.value)}
            className={inputClass}
            {...invalid('customer.phone')}
          />
        </Field>
        <Field
          id={fid('address.line1')}
          label={t.fullAddress}
          error={errors['address.line1']}
          hint={t.fullAddressHint}
        >
          <textarea
            id={fid('address.line1')}
            autoComplete="street-address"
            rows={2}
            value={details.line1}
            maxLength={200}
            onChange={(e) => setDetail('line1')(e.target.value)}
            className={cn(inputClass, 'h-auto py-3')}
            {...invalid('address.line1')}
          />
        </Field>
        {zones.length ? (
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">{t.deliveryArea}</legend>
            <div className="grid gap-2 sm:grid-cols-2" id={fid('zoneId')} tabIndex={-1}>
              {zones.map((z) => (
                <label
                  key={z.id}
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-3 rounded-store border-2 p-3 text-sm',
                    zoneId === z.id ? 'border-primary bg-tint' : 'border-line',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="zone"
                      value={z.id}
                      checked={zoneId === z.id}
                      onChange={() => setChosenZone(z.id)}
                      className="size-4 accent-(--primary)"
                    />
                    {z.name}
                  </span>
                  <span className="font-semibold">
                    {z.chargeMinor ? money(z.chargeMinor) : t.free}
                  </span>
                </label>
              ))}
            </div>
            {errors.zoneId ? <p className="mt-1 text-sm text-red-700">{errors.zoneId}</p> : null}
          </fieldset>
        ) : null}
        {props.noteField ? (
          <Field id={fid('note')} label={t.note} error={errors.note}>
            <textarea
              id={fid('note')}
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={cn(inputClass, 'h-auto py-3')}
            />
          </Field>
        ) : null}
        {/* Left empty by people; bots fill every field. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label>
            Website
            <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
          </label>
        </div>
      </div>

      <div className="space-y-3 rounded-store-lg border border-line bg-surface p-5">
        <h3 className="font-semibold">{t.yourOrder}</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="min-w-0">
              {product.name}
              {variant && variant.title !== 'Default' && product.variants.length > 1
                ? ` · ${variant.title}`
                : ''}{' '}
              × {num(wanted)}
            </dt>
            <dd className="shrink-0">
              {variant
                ? money(
                    packageCharge(variant.priceMinor, wanted, pkg?.priceMinor ?? null).totalMinor,
                  )
                : '–'}
            </dd>
          </div>
          {addOn && withAddOn ? (
            <div className="flex justify-between gap-3">
              <dt>{addOn.label}</dt>
              <dd>{money(addOn.priceMinor)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-3">
            <dt className="text-muted">{t.delivery}</dt>
            <dd>
              {!totals ? (
                '–'
              ) : totals.deliveryMinor === null ? (
                <span className="text-muted">{t.chooseArea}</span>
              ) : totals.deliveryMinor === 0 ? (
                t.free
              ) : (
                money(totals.deliveryMinor)
              )}
            </dd>
          </div>
          {totals && totals.savingMinor > 0 ? (
            <div className="flex justify-between gap-3 text-primary">
              <dt>{t.youSave(money(totals.savingMinor))}</dt>
              <dd />
            </div>
          ) : null}
          <div className="flex justify-between gap-3 border-t border-line pt-2 text-lg font-bold">
            <dt>{t.total}</dt>
            <dd>{totals ? money(totals.totalMinor) : '–'}</dd>
          </div>
          {totals && payNow > 0 ? (
            <>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">{t.payNowLabel}</dt>
                <dd className="font-semibold">{money(payNow)}</dd>
              </div>
              {totals.totalMinor > payNow ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">{t.payOnDelivery}</dt>
                  <dd>{money(totals.totalMinor - payNow)}</dd>
                </div>
              ) : null}
            </>
          ) : null}
        </dl>
        <PaymentChoice
          id={fid('payment')}
          options={options}
          pick={pick}
          onPick={setPick}
          money={money}
          t={t}
          error={errors['payment.gateway'] ?? errors['payment.method']}
          bold
        />
        {preview ? (
          <p className="rounded-store bg-ink p-3 text-sm text-white">{t.previewLandingForm}</p>
        ) : null}
        {formError ? (
          <p className="text-sm font-medium text-red-700" role="alert">
            {formError}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={placing || preview || Boolean(stockProblem)}
          className="flex h-14 w-full items-center justify-center rounded-store bg-primary text-lg font-bold text-on-primary shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {redirecting
            ? t.goingToPay
            : placing
              ? t.placing
              : payNow > 0 && totals?.deliveryMinor !== null
                ? t.placeAndPay(money(payNow))
                : buttonLabelWithTotal(
                    props.buttonLabel,
                    totals && totals.deliveryMinor !== null ? totals.totalMinor : undefined,
                    money,
                  )}
        </button>
      </div>
    </form>
  );
}

/** "Order now · ৳1,250": the amount on the button removes one more doubt. */
function buttonLabelWithTotal(
  label: string,
  totalMinor: number | undefined,
  money: (m: number) => string,
): string {
  return totalMinor ? `${label} · ${money(totalMinor)}` : label;
}
