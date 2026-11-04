'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Link2, RefreshCw, Truck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { commerceKeys } from '@/components/commerce/hooks';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Order, Parcel } from '@/lib/api/types';
import { EVENT_SOURCE, SHIPMENT_STATUS, canSendToCourier, formatWeight } from '@/lib/couriers';
import { formatDateTime, formatMoney, formatRelative } from '@/lib/format';
import { ShipmentBadge } from './badges';
import { BookDialog } from './book-dialog';
import { courierKeys, useOrderParcels } from './data';

function LinkDialog({
  parcel,
  open,
  onOpenChange,
  onDone,
}: {
  parcel: Parcel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (p: Parcel) => void;
}) {
  const { org } = useOrg();
  const [consignment, setConsignment] = useState('');
  const [tracking, setTracking] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const link = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<Parcel>(`/orgs/${org.id}/parcels/${parcel.id}/link`, {
        body: {
          consignmentId: consignment.trim(),
          ...(tracking.trim() ? { trackingCode: tracking.trim() } : {}),
        },
      }),
    onSuccess: (p) => {
      onDone(p);
      onOpenChange(false);
      toast.success('Booking linked. Sellora follows it from now on.');
    },
    onError: (err) =>
      setErrors(
        err instanceof ApiError && err.errors.length ? err.fieldErrors() : { _: errorMessage(err) },
      ),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Link the courier’s booking"
        description={`Find invoice ${parcel.invoice} in the ${parcel.providerName} panel and copy its consignment ID here.`}
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!consignment.trim()) return setErrors({ consignmentId: 'Required' });
            link.mutate();
          }}
        >
          {errors._ && <Alert tone="danger">{errors._}</Alert>}
          <Field label="Consignment ID" htmlFor="lk-cid" error={errors.consignmentId}>
            <Input
              id="lk-cid"
              value={consignment}
              maxLength={64}
              onChange={(e) => setConsignment(e.target.value)}
            />
          </Field>
          <Field label="Tracking code" htmlFor="lk-track" optional error={errors.trackingCode}>
            <Input
              id="lk-track"
              value={tracking}
              maxLength={64}
              onChange={(e) => setTracking(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={link.isPending}>
              Link booking
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-all">{children}</dd>
    </div>
  );
}

function CurrentParcel({ parcel, order }: { parcel: Parcel; order: Order }) {
  const { org, can } = useOrg();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<'cancel' | 'link' | null>(null);
  const manage = can('orders.manage');
  const updated = (p: Parcel) => {
    qc.setQueryData<Parcel[]>(courierKeys.parcels(org.id, order.id), (list) =>
      list?.map((x) => (x.id === p.id ? p : x)),
    );
    void qc.invalidateQueries({ queryKey: courierKeys.parcels(org.id, order.id) });
    void qc.invalidateQueries({ queryKey: commerceKeys.orders(org.id) });
  };
  const action = useMutation({
    mutationFn: (a: 'refresh' | 'dismiss') =>
      api<Parcel>(`/orgs/${org.id}/parcels/${parcel.id}/${a}`, { method: 'POST' }),
    onSuccess: (p, a) => {
      updated(p);
      toast.success(
        a === 'refresh'
          ? `${p.providerName}: ${SHIPMENT_STATUS[p.status].label.toLowerCase()}${p.providerStatus ? ` (${p.providerStatus})` : ''}.`
          : 'Note cleared.',
      );
    },
  });
  const lostReply = parcel.status === 'sending' && parcel.actions.link;

  return (
    <div className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <ShipmentBadge status={parcel.status} />
        <span className="text-muted-foreground">
          {parcel.providerName}
          {parcel.accountName !== parcel.providerName ? ` · ${parcel.accountName}` : ''}
        </span>
      </div>
      {parcel.attention && (
        <Alert
          tone="warning"
          action={
            manage &&
            parcel.actions.dismiss &&
            !lostReply && (
              <Button
                size="sm"
                variant="outline"
                className="bg-background"
                loading={action.isPending && action.variables === 'dismiss'}
                onClick={() => action.mutate('dismiss')}
              >
                Done
              </Button>
            )
          }
        >
          {parcel.attention}
        </Alert>
      )}
      {lostReply && manage && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setDialog('link')}>
            <Link2 /> It is booked: link it
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('cancel')}>
            Not booked
          </Button>
        </div>
      )}
      <dl className="grid gap-1.5">
        {parcel.consignmentId && (
          <Detail label="Consignment">
            <span className="font-mono">{parcel.consignmentId}</span>
          </Detail>
        )}
        {parcel.trackingCode && parcel.trackingCode !== parcel.consignmentId && (
          <Detail label="Tracking code">
            <span className="font-mono">{parcel.trackingCode}</span>
          </Detail>
        )}
        <Detail label="Invoice">
          <span className="font-mono">{parcel.invoice}</span>
        </Detail>
        <Detail label="Cash to collect">
          <span className="tabular">{formatMoney(parcel.codMinor, order.currency)}</span>
        </Detail>
        <Detail label="Weight">{formatWeight(parcel.weightGrams)}</Detail>
        {parcel.location?.areaName || parcel.location?.zoneName ? (
          <Detail label="Area">
            {[parcel.location.areaName, parcel.location.zoneName, parcel.location.cityName]
              .filter(Boolean)
              .join(', ')}
          </Detail>
        ) : null}
        {parcel.deliveryFeeMinor !== null && (
          <Detail label="Courier charge">
            <span className="tabular">{formatMoney(parcel.deliveryFeeMinor, order.currency)}</span>
          </Detail>
        )}
        {parcel.lastCheckedAt && (
          <Detail label="Last checked">{formatRelative(parcel.lastCheckedAt)}</Detail>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        {parcel.trackingUrl && (
          <Button asChild size="sm" variant="outline">
            <a href={parcel.trackingUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> Track
            </a>
          </Button>
        )}
        {parcel.trackingUrl && <CopyButton value={parcel.trackingUrl} label="Copy link" />}
        {manage && parcel.actions.refresh && (
          <Button
            size="sm"
            variant="outline"
            loading={action.isPending && action.variables === 'refresh'}
            onClick={() => action.mutate('refresh')}
          >
            <RefreshCw /> Check now
          </Button>
        )}
        {manage && parcel.actions.cancel && !lostReply && (
          <Button size="sm" variant="ghost" onClick={() => setDialog('cancel')}>
            <X /> Cancelled at courier
          </Button>
        )}
      </div>
      {action.isError && <Alert tone="danger">{errorMessage(action.error)}</Alert>}
      <ol className="mt-1 grid gap-2.5 border-l pl-4">
        {[...parcel.events].reverse().map((e, i) => (
          <li key={i} className="relative">
            <span
              className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-primary"
              aria-hidden
            />
            <p>
              <span className="font-medium">{SHIPMENT_STATUS[e.status].label}</span>
              {e.providerStatus && (
                <span className="text-muted-foreground"> · {e.providerStatus}</span>
              )}
            </p>
            {e.note && <p className="text-muted-foreground">{e.note}</p>}
            <p className="text-xs text-muted-foreground">
              {formatDateTime(e.at, org.timezone)} · {EVENT_SOURCE[e.source]}
            </p>
          </li>
        ))}
      </ol>
      <LinkDialog
        parcel={parcel}
        open={dialog === 'link'}
        onOpenChange={(v) => !v && setDialog(null)}
        onDone={updated}
      />
      <ConfirmDialog
        open={dialog === 'cancel'}
        onOpenChange={(v) => !v && setDialog(null)}
        destructive
        title={lostReply ? 'Mark as not booked?' : `Mark ${parcel.invoice} cancelled?`}
        description={
          lostReply
            ? `Only when invoice ${parcel.invoice} is not in the ${parcel.providerName} panel. The order can then be sent again.`
            : `Cancel the parcel in the ${parcel.providerName} panel first: Sellora cannot cancel bookings there. Sellora then stops tracking it and the order can be sent again.`
        }
        confirmLabel={lostReply ? 'Not booked' : 'Mark cancelled'}
        reason
        reasonLabel="Note (optional)"
        reasonMin={0}
        onConfirm={async (note) => {
          try {
            updated(
              await api<Parcel>(`/orgs/${org.id}/parcels/${parcel.id}/cancel`, {
                body: note ? { note } : {},
              }),
            );
            toast.success('Booking marked cancelled.');
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </div>
  );
}

/** The order's courier booking: send it, follow it, and deal with what goes wrong. */
export function CourierCard({ order }: { order: Order }) {
  const { org, can, modules } = useOrg();
  const qc = useQueryClient();
  const inPlan = modules === null || modules.includes('couriers');
  const parcels = useOrderParcels(org.id, order.id, inPlan);
  const [booking, setBooking] = useState(false);
  const current = parcels.data?.find((p) => p.current) ?? null;
  const past = parcels.data?.filter((p) => !p.current) ?? [];

  // A booking that moved on (booked, picked up, delivered) moves the order too.
  const shipmentStatus = order.shipment?.status;
  const parcelStatus = current?.status ?? parcels.data?.[0]?.status;
  useEffect(() => {
    if (parcelStatus && parcelStatus !== shipmentStatus)
      void qc.invalidateQueries({ queryKey: commerceKeys.order(org.id, order.id) });
  }, [parcelStatus, shipmentStatus, qc, org.id, order.id]);

  if (!inPlan) return null;
  const sendable = can('orders.manage') && canSendToCourier(order);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Courier</CardTitle>
        {sendable && !current && (
          <Button size="sm" onClick={() => setBooking(true)}>
            <Truck /> Send to courier
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {parcels.isPending ? (
          <Skeleton className="h-20" />
        ) : parcels.isError ? (
          <Alert tone="danger">{errorMessage(parcels.error)}</Alert>
        ) : current ? (
          <CurrentParcel parcel={current} order={order} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {order.status === 'pending'
              ? 'Confirm the order to send it to a courier.'
              : sendable
                ? 'Not sent to a courier yet.'
                : 'Not sent through Sellora.'}
          </p>
        )}
        {past.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Earlier attempts ({past.length})
            </summary>
            <ul className="mt-2 grid gap-2">
              {past.map((p) => (
                <li key={p.id} className="rounded-md border p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <ShipmentBadge status={p.status} />
                    <span className="font-mono text-xs">{p.invoice}</span>
                    <span className="text-xs text-muted-foreground">
                      {p.providerName} · {formatDateTime(p.createdAt, org.timezone)}
                    </span>
                  </div>
                  {(p.error ?? p.attention) && (
                    <p className="mt-1 text-muted-foreground">{p.error ?? p.attention}</p>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
      {sendable && <BookDialog order={order} open={booking} onOpenChange={setBooking} />}
    </Card>
  );
}
