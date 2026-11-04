'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Printer, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { AddressFields, cleanAddress, emptyAddress } from '@/components/commerce/address-fields';
import { OrderStatusBadge, PaymentBadge } from '@/components/commerce/badges';
import { commerceKeys, useShopSettings } from '@/components/commerce/hooks';
import {
  ItemsEditor,
  addLine,
  lineFromVariant,
  type DraftLine,
} from '@/components/commerce/items-editor';
import { MoneyInput } from '@/components/commerce/money-input';
import { CourierCard } from '@/components/couriers/courier-card';
import { RiskCard } from '@/components/couriers/risk-card';
import { OrderSmsCard } from '@/components/sms/messages-card';
import { PageError } from '@/components/commerce/page-error';
import { ProductPicker } from '@/components/commerce/product-picker';
import { ProductThumb } from '@/components/commerce/product-thumb';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Address, Order, OrderStatus, PaymentMethod } from '@/lib/api/types';
import {
  ORDER_SOURCE_LABEL,
  ORDER_STATUS,
  PAYMENT_METHODS,
  STATUS_ACTION,
  addressLines,
  orderTotals,
  paymentMethodLabel,
} from '@/lib/commerce';
import { SHIPMENT_IN_PROGRESS } from '@/lib/couriers';
import { formatDateTime, formatMoney, minorToInput, parseMoney } from '@/lib/format';

function Money({ minor, currency }: { minor: number; currency: string }) {
  return <span className="tabular">{formatMoney(minor, currency)}</span>;
}

function ItemsCard({ order, onSaved }: { order: Order; onSaved: (o: Order) => void }) {
  const { org, can } = useOrg();
  const settings = useShopSettings(org.id);
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [discount, setDiscount] = useState('');
  const [delivery, setDelivery] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const c = order.currency;
  const canEdit = order.editable && can('orders.manage');

  const start = () => {
    setLines(
      order.items.map((i) => ({
        productId: i.productId,
        variantId: i.variantId,
        name: i.name,
        variantTitle: i.variantTitle,
        imageUrl: i.imageUrl,
        price: minorToInput(i.unitPriceMinor, c),
        quantity: i.quantity,
        stock: null,
      })),
    );
    setDiscount(order.discountMinor ? minorToInput(order.discountMinor, c) : '');
    setDelivery(minorToInput(order.deliveryChargeMinor, c));
    setZoneId(order.deliveryZone?.id ?? '');
    setErrors({});
    setError(null);
    setEditing(true);
  };

  const discountMinor = parseMoney(discount || '0', c);
  const deliveryMinor = parseMoney(delivery || '0', c);
  const priced = lines.map((l) => parseMoney(l.price, c));
  const draft = orderTotals(
    lines.map((l, i) => ({ unitPriceMinor: priced[i] ?? 0, quantity: l.quantity })),
    discountMinor ?? 0,
    deliveryMinor ?? 0,
  );
  const lineErrors: Record<number, string | undefined> = {};
  for (const [k, v] of Object.entries(errors)) {
    const m = /^items\.(\d+)/.exec(k);
    if (m) lineErrors[Number(m[1])] = v;
  }

  const save = () => {
    if (!lines.length)
      return setError('An order needs at least one item. Cancel the order instead.');
    if (priced.some((p) => p === null) || discountMinor === null || deliveryMinor === null)
      return setError('Check the amounts.');
    setBusy(true);
    setError(null);
    setErrors({});
    api<Order>(`/orgs/${org.id}/orders/${order.id}/items`, {
      method: 'PUT',
      body: {
        items: lines.map((l, i) => ({
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
          unitPriceMinor: priced[i]!,
        })),
        discountMinor,
        deliveryZoneId: zoneId || null,
        deliveryChargeMinor: deliveryMinor,
      },
    })
      .then((o) => {
        onSaved(o);
        setEditing(false);
        toast.success(order.stockCommitted ? 'Items and stock updated.' : 'Items updated.');
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError) setErrors(err.fieldErrors());
        setError(errorMessage(err));
      })
      .finally(() => setBusy(false));
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Items</CardTitle>
        {canEdit && !editing && (
          <Button variant="ghost" size="sm" onClick={start}>
            <Pencil /> Edit items
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {editing ? (
          <>
            {error && <Alert tone="danger">{error}</Alert>}
            <ProductPicker
              orgId={org.id}
              onPick={(p, v) => setLines((ls) => addLine(ls, lineFromVariant(p, v)))}
            />
            <ItemsEditor lines={lines} onChange={setLines} currency={c} errors={lineErrors} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Delivery zone" htmlFor="e-zone">
                <NativeSelect
                  id="e-zone"
                  value={zoneId}
                  onChange={(e) => {
                    setZoneId(e.target.value);
                    const z = settings.data?.deliveryZones.find((x) => x.id === e.target.value);
                    setDelivery(minorToInput(z?.chargeMinor ?? 0, c));
                  }}
                >
                  <option value="">No zone</option>
                  {settings.data?.deliveryZones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field
                label="Delivery charge"
                htmlFor="e-delivery"
                error={deliveryMinor === null ? 'Enter an amount' : undefined}
              >
                <MoneyInput
                  id="e-delivery"
                  currency={c}
                  value={delivery}
                  onChange={(e) => setDelivery(e.target.value)}
                />
              </Field>
              <Field
                label="Discount"
                htmlFor="e-discount"
                error={
                  discountMinor === null
                    ? 'Enter an amount'
                    : draft.discountTooLarge
                      ? 'More than the items'
                      : errors.discountMinor
                }
              >
                <MoneyInput
                  id="e-discount"
                  currency={c}
                  value={discount}
                  placeholder="0"
                  onChange={(e) => setDiscount(e.target.value)}
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
              <p className="text-sm">
                New total <strong className="tabular">{formatMoney(draft.totalMinor, c)}</strong>
                {order.stockCommitted && (
                  <span className="block text-xs text-muted-foreground">
                    Only the difference in quantities is taken from or returned to stock.
                  </span>
                )}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button loading={busy} onClick={save}>
                  Save items
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            <ul className="divide-y">
              {order.items.map((i) => (
                <li key={i.variantId} className="flex items-center gap-3 py-2.5 first:pt-0">
                  <ProductThumb url={i.imageUrl} />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/app/${org.id}/products/${i.productId}`}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {i.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {[i.variantTitle, i.sku].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tabular text-sm font-medium">{formatMoney(i.totalMinor, c)}</p>
                    <p className="tabular text-xs text-muted-foreground">
                      {i.quantity} × {formatMoney(i.unitPriceMinor, c)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <dl className="ml-auto grid w-full max-w-xs gap-1.5 border-t pt-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Items</dt>
                <dd>
                  <Money minor={order.subtotalMinor} currency={c} />
                </dd>
              </div>
              {order.discountMinor > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Discount</dt>
                  <dd>
                    −<Money minor={order.discountMinor} currency={c} />
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted-foreground">
                  Delivery{order.deliveryZone ? ` (${order.deliveryZone.name})` : ''}
                </dt>
                <dd>
                  <Money minor={order.deliveryChargeMinor} currency={c} />
                </dd>
              </div>
              <div className="flex justify-between border-t pt-1.5 text-base font-semibold">
                <dt>Total</dt>
                <dd>
                  <Money minor={order.totalMinor} currency={c} />
                </dd>
              </div>
            </dl>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PaymentDialog({
  order,
  open,
  onOpenChange,
  onSaved,
}: {
  order: Order;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (o: Order) => void;
}) {
  const { org } = useOrg();
  const c = order.currency;
  const [paid, setPaid] = useState(minorToInput(order.payment.paidMinor, c));
  const [method, setMethod] = useState<PaymentMethod>(order.payment.method);
  const [reference, setReference] = useState(order.payment.reference ?? '');
  const [refunded, setRefunded] = useState(order.payment.status === 'refunded');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paidMinor = parseMoney(paid || '0', c);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Payment"
        description={`Order total ${formatMoney(order.totalMinor, c)}.`}
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (paidMinor === null) return;
            setBusy(true);
            setError(null);
            api<Order>(`/orgs/${org.id}/orders/${order.id}/payment`, {
              body: { paidMinor, method, reference: reference.trim() || null, refunded },
            })
              .then((o) => {
                onSaved(o);
                onOpenChange(false);
              })
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setBusy(false));
          }}
        >
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Amount paid"
              htmlFor="pay-paid"
              error={paidMinor === null ? 'Enter an amount' : undefined}
            >
              <MoneyInput
                id="pay-paid"
                currency={c}
                value={paid}
                onChange={(e) => setPaid(e.target.value)}
              />
            </Field>
            <Field label="Method" htmlFor="pay-method">
              <NativeSelect
                id="pay-method"
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
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPaid(minorToInput(order.totalMinor, c))}
            >
              Paid in full
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPaid('0')}>
              Nothing paid
            </Button>
          </div>
          <Field label="Transaction ID" htmlFor="pay-ref" optional>
            <Input
              id="pay-ref"
              value={reference}
              maxLength={120}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={refunded} onCheckedChange={(v) => setRefunded(v === true)} />
            The money was refunded to the customer
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={paidMinor === null}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DetailsDialog({
  order,
  open,
  onOpenChange,
  onSaved,
}: {
  order: Order;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (o: Order) => void;
}) {
  const { org } = useOrg();
  const [address, setAddress] = useState<Address>({ ...emptyAddress, ...order.shippingAddress });
  const [customerNote, setCustomerNote] = useState(order.customerNote);
  const [internalNote, setInternalNote] = useState(order.internalNote);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Delivery details and notes" wide>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            setErrors({});
            api<Order>(`/orgs/${org.id}/orders/${order.id}`, {
              method: 'PATCH',
              body: {
                ...(order.editable ? { shippingAddress: cleanAddress(address) } : {}),
                customerNote,
                internalNote,
              },
            })
              .then((o) => {
                onSaved(o);
                onOpenChange(false);
              })
              .catch((err: unknown) => {
                if (err instanceof ApiError) setErrors(err.fieldErrors());
                setError(errorMessage(err));
              })
              .finally(() => setBusy(false));
          }}
        >
          {error && <Alert tone="danger">{error}</Alert>}
          {order.editable ? (
            <AddressFields
              idPrefix="d-addr"
              value={address}
              onChange={setAddress}
              withRecipient
              errors={{
                line1: errors['shippingAddress.line1'],
                phone: errors['shippingAddress.phone'],
              }}
            />
          ) : order.shipment && SHIPMENT_IN_PROGRESS.includes(order.shipment.status) ? (
            <Alert tone="info">
              The parcel is booked with {order.shipment.accountName}. To change the address, cancel
              it at the courier and mark it cancelled here first.
            </Alert>
          ) : (
            <Alert tone="info">The address cannot change after the parcel has shipped.</Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Note from the customer" htmlFor="d-cnote" optional>
              <Textarea
                id="d-cnote"
                value={customerNote}
                maxLength={2000}
                onChange={(e) => setCustomerNote(e.target.value)}
              />
            </Field>
            <Field label="Internal note" htmlFor="d-inote" optional>
              <Textarea
                id="d-inote"
                value={internalNote}
                maxLength={2000}
                onChange={(e) => setInternalNote(e.target.value)}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const ATTRIBUTION_LABEL: Record<string, string> = {
  utmSource: 'Source',
  utmMedium: 'Medium',
  utmCampaign: 'Campaign',
  utmContent: 'Ad',
  utmTerm: 'Keyword',
  fbclid: 'Facebook click',
  gclid: 'Google click',
  ttclid: 'TikTok click',
  referrer: 'Came from',
};

/** The landing page an order came from and the ad link the shopper followed. */
function SourceCard({ order: o }: { order: Order }) {
  const { org, can } = useOrg();
  const entries = Object.entries(o.attribution ?? {}).filter(([, v]) => Boolean(v));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Where it came from</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {o.landingPage && (
          <p>
            Landing page{' '}
            {can('stores.view') ? (
              <Link
                href={`/app/${org.id}/landing-pages/${o.landingPage.id}`}
                className="font-medium text-primary hover:underline"
              >
                {o.landingPage.name}
              </Link>
            ) : (
              <span className="font-medium">{o.landingPage.name}</span>
            )}{' '}
            <span className="text-muted-foreground">/{o.landingPage.slug}</span>
          </p>
        )}
        {entries.length > 0 ? (
          <dl className="grid gap-1.5">
            {entries.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{ATTRIBUTION_LABEL[k] ?? k}</dt>
                <dd className="truncate font-mono text-xs" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground">No ad link: the shopper opened the page directly.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function OrderPage() {
  const { org, can } = useOrg();
  const { orderId } = useParams<{ orderId: string }>();
  const queryClient = useQueryClient();
  const key = commerceKeys.order(org.id, orderId);
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<Order>(`/orgs/${org.id}/orders/${orderId}`),
  });
  const [dialog, setDialog] = useState<'payment' | 'details' | 'cancel' | 'return' | null>(null);
  const [restock, setRestock] = useState(true);
  const [moving, setMoving] = useState<OrderStatus | null>(null);

  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.isError) return <PageError error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  const saved = (next: Order) => {
    queryClient.setQueryData(key, next);
    void queryClient.invalidateQueries({ queryKey: commerceKeys.all(org.id) });
  };
  const move = (status: OrderStatus, extra: Record<string, unknown> = {}) => {
    setMoving(status);
    return api<Order>(`/orgs/${org.id}/orders/${o.id}/status`, { body: { status, ...extra } })
      .then((next) => {
        saved(next);
        toast.success(`Order ${ORDER_STATUS[status].label.toLowerCase()}.`);
      })
      .catch((err: unknown) => {
        toast.error(errorMessage(err));
        throw err;
      })
      .finally(() => setMoving(null));
  };
  const forward = o.allowedTransitions.filter((s) => s !== 'cancelled' && s !== 'returned');
  const print = (doc: 'invoice' | 'slip') => `/app/${org.id}/orders/print?doc=${doc}&ids=${o.id}`;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link href={`/app/${org.id}/orders`}>
          <ArrowLeft /> Orders
        </Link>
      </Button>
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono">{o.number}</span> <OrderStatusBadge status={o.status} />
            <PaymentBadge status={o.payment.status} />
          </span>
        }
        description={`Placed ${formatDateTime(o.placedAt, org.timezone)} · ${ORDER_SOURCE_LABEL[o.source] ?? o.source}${o.landingPage ? `: ${o.landingPage.name}` : ''}`}
        actions={
          <>
            {can('orders.manage') &&
              forward.map((s, i) => (
                <Button
                  key={s}
                  variant={i === 0 ? 'default' : 'outline'}
                  loading={moving === s}
                  disabled={moving !== null}
                  onClick={() => void move(s).catch(() => undefined)}
                >
                  {STATUS_ACTION[s]}
                </Button>
              ))}
            {can('orders.manage') && o.allowedTransitions.includes('returned') && (
              <Button variant="outline" onClick={() => setDialog('return')}>
                {STATUS_ACTION.returned}
              </Button>
            )}
            {can('orders.cancel') && o.allowedTransitions.includes('cancelled') && (
              <Button variant="outline" onClick={() => setDialog('cancel')}>
                <X /> Cancel order
              </Button>
            )}
            {can('orders.print') && (
              <>
                <Button asChild variant="outline">
                  <a href={print('invoice')} target="_blank" rel="noopener">
                    <Printer /> Invoice
                  </a>
                </Button>
                <Button asChild variant="outline">
                  <a href={print('slip')} target="_blank" rel="noopener">
                    <Printer /> Packing slip
                  </a>
                </Button>
              </>
            )}
          </>
        }
      />
      {o.status === 'pending' && (
        <Alert tone="warning" className="mb-6">
          Pending orders do not hold stock yet. Confirm after you have spoken to the customer.
        </Alert>
      )}
      {o.status === 'cancelled' && o.cancelReason && (
        <Alert tone="info" className="mb-6">
          Cancelled: {o.cancelReason}
        </Alert>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_320px]">
        <div className="grid gap-6">
          <ItemsCard key={o.updatedAt} order={o} onSaved={saved} />
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-3 border-l pl-4 text-sm">
                {[...o.history].reverse().map((h, i) => (
                  <li key={i} className="relative">
                    <span
                      className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-primary"
                      aria-hidden
                    />
                    <p>
                      <span className="font-medium">{ORDER_STATUS[h.status].label}</span>
                      {h.note && <span className="text-muted-foreground"> · {h.note}</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(h.at, org.timezone)}
                      {h.actor.type === 'user' ? '' : ` · ${h.actor.type}`}
                    </p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-6">
          {(o.landingPage || o.attribution) && <SourceCard order={o} />}
          <CourierCard order={o} />
          {o.status !== 'cancelled' && <RiskCard phone={o.customer.phone} />}
          <OrderSmsCard orderId={o.id} />
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle>Payment</CardTitle>
              {can('orders.manage') && (
                <Button variant="ghost" size="sm" onClick={() => setDialog('payment')}>
                  Update
                </Button>
              )}
            </CardHeader>
            <CardContent>
              <dl className="grid gap-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Method</dt>
                  <dd>{paymentMethodLabel(o.payment.method)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Paid</dt>
                  <dd>
                    <Money minor={o.payment.paidMinor} currency={o.currency} />
                  </dd>
                </div>
                <div className="flex justify-between font-medium">
                  <dt>To collect</dt>
                  <dd>
                    <Money minor={o.dueMinor} currency={o.currency} />
                  </dd>
                </div>
                {o.payment.reference && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Transaction</dt>
                    <dd className="font-mono text-xs">{o.payment.reference}</dd>
                  </div>
                )}
              </dl>
              {o.refundDueMinor > 0 && (
                <Alert tone="warning" className="mt-3" title="Refund due">
                  <p>
                    The customer paid {formatMoney(o.refundDueMinor, o.currency)} more than the
                    order now costs.
                  </p>
                  {can('orders.manage') && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 bg-background"
                      onClick={() =>
                        void api<Order>(`/orgs/${org.id}/orders/${o.id}/payment`, {
                          body: { paidMinor: o.totalMinor },
                        })
                          .then((next) => {
                            saved(next);
                            toast.success('Refund recorded.');
                          })
                          .catch((err: unknown) => toast.error(errorMessage(err)))
                      }
                    >
                      I refunded it
                    </Button>
                  )}
                </Alert>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle>Customer</CardTitle>
              {can('orders.manage') && (
                <Button variant="ghost" size="sm" onClick={() => setDialog('details')}>
                  Edit
                </Button>
              )}
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
              <div>
                {can('customers.view') ? (
                  <Link
                    href={`/app/${org.id}/customers/${o.customerId}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {o.customer.name}
                  </Link>
                ) : (
                  <p className="font-medium">{o.customer.name}</p>
                )}
                {o.customer.phone && <p>{o.customer.phone}</p>}
                {o.customer.email && <p className="text-muted-foreground">{o.customer.email}</p>}
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">
                  Deliver to
                </p>
                {o.shippingAddress.name && <p>{o.shippingAddress.name}</p>}
                {addressLines(o.shippingAddress).map((l) => (
                  <p key={l}>{l}</p>
                ))}
                {o.shippingAddress.phone && <p>{o.shippingAddress.phone}</p>}
              </div>
              {o.customerNote && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">
                    Customer note
                  </p>
                  <p className="whitespace-pre-line">{o.customerNote}</p>
                </div>
              )}
              {o.internalNote && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">
                    Internal note
                  </p>
                  <p className="whitespace-pre-line">{o.internalNote}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {dialog === 'payment' && (
        <PaymentDialog order={o} open onOpenChange={(v) => !v && setDialog(null)} onSaved={saved} />
      )}
      {dialog === 'details' && (
        <DetailsDialog order={o} open onOpenChange={(v) => !v && setDialog(null)} onSaved={saved} />
      )}
      <ConfirmDialog
        open={dialog === 'cancel'}
        onOpenChange={(v) => !v && setDialog(null)}
        destructive
        title={`Cancel order ${o.number}?`}
        description={
          o.stockCommitted ? 'Its items go back into stock.' : 'This order did not hold any stock.'
        }
        confirmLabel="Cancel order"
        reason
        reasonLabel="Why is it cancelled?"
        onConfirm={async (reason) => {
          try {
            saved(await api<Order>(`/orgs/${org.id}/orders/${o.id}/cancel`, { body: { reason } }));
            toast.success('Order cancelled.');
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
      <ConfirmDialog
        open={dialog === 'return'}
        onOpenChange={(v) => {
          if (!v) setDialog(null);
          setRestock(true);
        }}
        title={`Mark ${o.number} as returned?`}
        description="Use this when the courier brings the parcel back or the customer returns it."
        confirmLabel="Mark returned"
        onConfirm={() => move('returned', { restock })}
      >
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={restock}
            onCheckedChange={(v) => setRestock(v === true)}
            className="mt-0.5"
          />
          <span>
            Put the items back into stock
            <span className="block text-xs text-muted-foreground">
              Turn off if the goods came back damaged.
            </span>
          </span>
        </label>
      </ConfirmDialog>
    </>
  );
}
