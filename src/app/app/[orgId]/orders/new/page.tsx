'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, UserRound, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AddressFields, cleanAddress, emptyAddress } from '@/components/commerce/address-fields';
import { commerceKeys, useShopSettings } from '@/components/commerce/hooks';
import {
  ItemsEditor,
  addLine,
  lineFromVariant,
  type DraftLine,
} from '@/components/commerce/items-editor';
import { MoneyInput } from '@/components/commerce/money-input';
import { PageError } from '@/components/commerce/page-error';
import { ProductPicker } from '@/components/commerce/product-picker';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Address, Customer, Order, Page, PaymentMethod } from '@/lib/api/types';
import { PAYMENT_METHODS, addressLines, orderTotals } from '@/lib/commerce';
import { formatMoney, minorToInput, parseMoney } from '@/lib/format';

function CustomerSearch({ onPick }: { onPick: (c: Customer) => void }) {
  const { org } = useOrg();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 200);
  const results = useQuery({
    queryKey: [...commerceKeys.customers(org.id), 'picker', q],
    queryFn: () => api<Page<Customer>>(`/orgs/${org.id}/customers`, { query: { q, limit: 6 } }),
    enabled: q.length >= 2,
  });
  return (
    <div className="grid gap-2">
      <Field label="Find an existing customer" htmlFor="cust-search" optional>
        <Input
          id="cust-search"
          placeholder="Phone or name"
          value={search}
          autoComplete="off"
          onChange={(e) => setSearch(e.target.value)}
        />
      </Field>
      {q.length >= 2 && results.data && (
        <ul className="divide-y rounded-md border bg-card text-sm">
          {results.data.items.length === 0 ? (
            <li className="p-3 text-muted-foreground">No match. Fill in the new customer below.</li>
          ) : (
            results.data.items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-accent"
                  onClick={() => {
                    onPick(c);
                    setSearch('');
                  }}
                >
                  <span>
                    <span className="font-medium">{c.name}</span>{' '}
                    <span className="text-muted-foreground">{c.phone}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {c.blocked && <Badge tone="danger">Blocked</Badge>}
                    {c.stats.orders} orders
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function NewOrder() {
  const { org, can } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const settings = useShopSettings(org.id);
  const currency = org.currency;

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState<Address>(emptyAddress);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [zoneId, setZoneId] = useState<string | null | undefined>(undefined);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [discount, setDiscount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cod');
  const [paid, setPaid] = useState('');
  const [reference, setReference] = useState('');
  const [customerNote, setCustomerNote] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [confirmNow, setConfirmNow] = useState<boolean | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [blockedId, setBlockedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (c: Customer) => {
    setCustomer(c);
    setName(c.name);
    setPhone(c.phone ?? '');
    setEmail(c.email ?? '');
    setAddress(c.addresses[0] ? { ...emptyAddress, ...c.addresses[0] } : emptyAddress);
  };

  const presetId = params.get('customerId');
  const preset = useQuery({
    queryKey: commerceKeys.customer(org.id, presetId ?? 'none'),
    queryFn: () => api<Customer>(`/orgs/${org.id}/customers/${presetId}`),
    enabled: Boolean(presetId),
  });
  useEffect(() => {
    // Fill the form once when opened from a customer's page.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time prefill from a query
    if (preset.data && !customer) pick(preset.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset.data]);

  const zones = settings.data?.deliveryZones ?? [];
  const effectiveZoneId = zoneId === undefined ? (settings.data?.defaultZoneId ?? null) : zoneId;
  const zone = zones.find((z) => z.id === effectiveZoneId) ?? null;
  const deliveryText = delivery ?? (zone ? minorToInput(zone.chargeMinor, currency) : '0');
  const deliveryMinor = parseMoney(deliveryText || '0', currency);
  const discountMinor = parseMoney(discount || '0', currency);
  const paidMinor = parseMoney(paid || '0', currency);
  const priced = lines.map((l) => ({
    unitPriceMinor: parseMoney(l.price, currency),
    quantity: l.quantity,
  }));
  const pricesValid = priced.every((l) => l.unitPriceMinor !== null);
  const totals = orderTotals(
    priced.map((l) => ({ unitPriceMinor: l.unitPriceMinor ?? 0, quantity: l.quantity })),
    discountMinor ?? 0,
    deliveryMinor ?? 0,
  );
  const willConfirm = confirmNow ?? settings.data?.autoConfirmManualOrders ?? true;

  const lineErrors: Record<number, string | undefined> = {};
  for (const [k, v] of Object.entries(errors)) {
    const m = /^items\.(\d+)/.exec(k);
    if (m) lineErrors[Number(m[1])] = v;
  }

  const submit = async (allowBlockedCustomer = false) => {
    setError(null);
    setErrors({});
    setBlockedId(null);
    if (!lines.length) return setError('Add at least one product.');
    if (!name.trim()) return setErrors({ 'customer.name': 'Enter the customer’s name' });
    if (!address.line1.trim())
      return setErrors({ 'shippingAddress.line1': 'Enter the delivery address' });
    if (!pricesValid || deliveryMinor === null || discountMinor === null || paidMinor === null)
      return setError('Check the amounts.');
    setBusy(true);
    try {
      const order = await api<Order>(`/orgs/${org.id}/orders`, {
        body: {
          customer: {
            ...(customer ? { id: customer.id } : {}),
            name: name.trim(),
            ...(phone.trim() ? { phone: phone.trim() } : {}),
            ...(email.trim() ? { email: email.trim() } : {}),
          },
          shippingAddress: cleanAddress(address),
          items: lines.map((l, i) => {
            const unit = priced[i]!.unitPriceMinor!;
            return {
              productId: l.productId,
              variantId: l.variantId,
              quantity: l.quantity,
              unitPriceMinor: unit,
            };
          }),
          deliveryZoneId: effectiveZoneId,
          deliveryChargeMinor: deliveryMinor,
          ...(discountMinor ? { discountMinor } : {}),
          payment: {
            method,
            ...(paidMinor ? { paidMinor } : {}),
            ...(reference.trim() ? { reference: reference.trim() } : {}),
          },
          ...(customerNote.trim() ? { customerNote: customerNote.trim() } : {}),
          ...(internalNote.trim() ? { internalNote: internalNote.trim() } : {}),
          status: willConfirm ? 'confirmed' : 'pending',
          ...(allowBlockedCustomer ? { allowBlockedCustomer: true } : {}),
        },
      });
      await queryClient.invalidateQueries({ queryKey: commerceKeys.all(org.id) });
      toast.success(`Order ${order.number} created.`);
      router.push(`/app/${org.id}/orders/${order.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors());
        if (err.code === 'customer_blocked') setBlockedId(String(err.details.customerId ?? ''));
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!can('orders.create')) return <EmptyState title="Your role cannot create orders" />;
  if (settings.isError)
    return <PageError error={settings.error} onRetry={() => void settings.refetch()} />;
  if (settings.isPending) return <Skeleton className="h-96" />;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link href={`/app/${org.id}/orders`}>
          <ArrowLeft /> Orders
        </Link>
      </Button>
      <PageHeader title="New order" description="For orders taken by phone, chat or in person." />
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="grid items-start gap-6 lg:grid-cols-[1fr_340px]"
      >
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Items</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <ProductPicker
                orgId={org.id}
                onPick={(p, v) => setLines((ls) => addLine(ls, lineFromVariant(p, v)))}
              />
              <ItemsEditor
                lines={lines}
                onChange={setLines}
                currency={currency}
                errors={lineErrors}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Customer</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {customer ? (
                <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/40 p-3 text-sm">
                  <div className="flex items-start gap-3">
                    <UserRound className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
                    <div>
                      <p className="font-medium">
                        {customer.name} {customer.blocked && <Badge tone="danger">Blocked</Badge>}
                      </p>
                      <p className="text-muted-foreground">
                        {customer.stats.orders} orders · {customer.stats.delivered} delivered ·{' '}
                        {customer.stats.returned} returned
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Use a different customer"
                    onClick={() => {
                      setCustomer(null);
                      setName('');
                      setPhone('');
                      setEmail('');
                      setAddress(emptyAddress);
                    }}
                  >
                    <X />
                  </Button>
                </div>
              ) : (
                <CustomerSearch onPick={pick} />
              )}
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Name" htmlFor="o-name" error={errors['customer.name']}>
                  <Input
                    id="o-name"
                    value={name}
                    maxLength={120}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field
                  label="Phone"
                  htmlFor="o-phone"
                  optional
                  error={errors['customer.phone']}
                  hint={customer ? undefined : 'Matches an existing customer automatically'}
                >
                  <Input
                    id="o-phone"
                    type="tel"
                    inputMode="tel"
                    value={phone}
                    disabled={Boolean(customer)}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </Field>
                <Field label="Email" htmlFor="o-email" optional error={errors['customer.email']}>
                  <Input
                    id="o-email"
                    type="email"
                    value={email}
                    disabled={Boolean(customer)}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
              </div>
              {customer && customer.addresses.length > 1 && (
                <Field label="Saved addresses" htmlFor="o-saved">
                  <NativeSelect
                    id="o-saved"
                    onChange={(e) => {
                      const a = customer.addresses[Number(e.target.value)];
                      if (a) setAddress({ ...emptyAddress, ...a });
                    }}
                  >
                    {customer.addresses.map((a, i) => (
                      <option key={i} value={i}>
                        {addressLines(a).join(', ')}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
              <AddressFields
                idPrefix="o-addr"
                value={address}
                onChange={setAddress}
                withRecipient
                errors={{
                  line1: errors['shippingAddress.line1'],
                  phone: errors['shippingAddress.phone'],
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Note from the customer"
                htmlFor="o-cnote"
                optional
                hint="Printed on the invoice"
              >
                <Textarea
                  id="o-cnote"
                  value={customerNote}
                  maxLength={2000}
                  onChange={(e) => setCustomerNote(e.target.value)}
                />
              </Field>
              <Field
                label="Internal note"
                htmlFor="o-inote"
                optional
                hint="Only your team sees this"
              >
                <Textarea
                  id="o-inote"
                  value={internalNote}
                  maxLength={2000}
                  onChange={(e) => setInternalNote(e.target.value)}
                />
              </Field>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 lg:sticky lg:top-20">
          <Card>
            <CardHeader>
              <CardTitle>Delivery and payment</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field
                label="Delivery zone"
                htmlFor="o-zone"
                hint={
                  zones.length === 0 ? (
                    <Link
                      href={`/app/${org.id}/settings/selling`}
                      className="text-primary hover:underline"
                    >
                      Set up delivery charges
                    </Link>
                  ) : undefined
                }
              >
                <NativeSelect
                  id="o-zone"
                  value={effectiveZoneId ?? ''}
                  onChange={(e) => {
                    setZoneId(e.target.value || null);
                    setDelivery(null);
                  }}
                >
                  <option value="">No zone</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name} ({formatMoney(z.chargeMinor, currency)})
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Delivery charge"
                  htmlFor="o-delivery"
                  error={deliveryMinor === null ? 'Enter an amount' : errors.deliveryChargeMinor}
                >
                  <MoneyInput
                    id="o-delivery"
                    currency={currency}
                    value={deliveryText}
                    onChange={(e) => setDelivery(e.target.value)}
                  />
                </Field>
                <Field
                  label="Discount"
                  htmlFor="o-discount"
                  error={
                    discountMinor === null
                      ? 'Enter an amount'
                      : totals.discountTooLarge
                        ? 'More than the items'
                        : errors.discountMinor
                  }
                >
                  <MoneyInput
                    id="o-discount"
                    currency={currency}
                    value={discount}
                    placeholder="0"
                    onChange={(e) => setDiscount(e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Payment method" htmlFor="o-method">
                <NativeSelect
                  id="o-method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Paid now"
                  htmlFor="o-paid"
                  error={
                    paidMinor === null
                      ? 'Enter an amount'
                      : paidMinor > totals.totalMinor
                        ? 'More than the total'
                        : errors['payment.paidMinor']
                  }
                >
                  <MoneyInput
                    id="o-paid"
                    currency={currency}
                    value={paid}
                    placeholder="0"
                    onChange={(e) => setPaid(e.target.value)}
                  />
                </Field>
                <Field label="Transaction ID" htmlFor="o-ref" optional>
                  <Input
                    id="o-ref"
                    value={reference}
                    maxLength={120}
                    onChange={(e) => setReference(e.target.value)}
                  />
                </Field>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="grid gap-3 pt-5">
              <dl className="grid gap-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Items</dt>
                  <dd className="tabular">{formatMoney(totals.subtotalMinor, currency)}</dd>
                </div>
                {totals.discountMinor > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Discount</dt>
                    <dd className="tabular">−{formatMoney(totals.discountMinor, currency)}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Delivery</dt>
                  <dd className="tabular">{formatMoney(totals.deliveryChargeMinor, currency)}</dd>
                </div>
                <div className="flex justify-between border-t pt-1.5 text-base font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular">{formatMoney(totals.totalMinor, currency)}</dd>
                </div>
                {(paidMinor ?? 0) > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">To collect</dt>
                    <dd className="tabular font-medium">
                      {formatMoney(Math.max(0, totals.totalMinor - (paidMinor ?? 0)), currency)}
                    </dd>
                  </div>
                )}
              </dl>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={willConfirm}
                  onCheckedChange={(v) => setConfirmNow(v === true)}
                  className="mt-0.5"
                />
                <span>
                  Confirm now
                  <span className="block text-xs text-muted-foreground">
                    Takes the items out of stock. Leave off to keep it pending until you call the
                    customer.
                  </span>
                </span>
              </label>
              {error && (
                <Alert
                  tone="danger"
                  action={
                    blockedId !== null && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        loading={busy}
                        onClick={() => void submit(true)}
                      >
                        Place anyway
                      </Button>
                    )
                  }
                >
                  {error}
                </Alert>
              )}
              <Button type="submit" loading={busy} disabled={!lines.length}>
                Create order
              </Button>
            </CardContent>
          </Card>
        </div>
      </form>
    </>
  );
}

export default function NewOrderPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <NewOrder />
    </Suspense>
  );
}
