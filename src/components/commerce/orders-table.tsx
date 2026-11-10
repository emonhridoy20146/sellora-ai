'use client';

import Link from 'next/link';
import { RiskBadge, ShipmentBadge } from '@/components/couriers/badges';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import type { FraudBatch, Order } from '@/lib/api/types';
import { formatDateTime, formatMoney } from '@/lib/format';
import { OnlinePaymentBadge, OrderStatusBadge, PaymentBadge } from './badges';

function PhoneRisk({ risk }: { risk: FraudBatch['items'][number] | undefined }) {
  if (!risk) return null;
  return (
    <span className="mt-0.5 block">
      <RiskBadge compact level={risk.level} successRate={risk.successRate} />
    </span>
  );
}

/**
 * Orders as a table; with `selected`, rows get checkboxes for bulk actions. `risk` adds a
 * delivery-risk badge under each customer's number.
 */
export function OrdersTable({
  orgId,
  orders,
  timezone,
  showCustomer = true,
  showCourier = true,
  risk,
  selected,
  onSelect,
}: {
  orgId: string;
  orders: Order[];
  timezone: string;
  showCustomer?: boolean;
  showCourier?: boolean;
  risk?: Map<string, FraudBatch['items'][number]>;
  selected?: Set<string>;
  onSelect?: (ids: Set<string>) => void;
}) {
  const selectable = selected !== undefined && onSelect !== undefined;
  const allSelected = selectable && orders.length > 0 && orders.every((o) => selected.has(o.id));
  const toggle = (id: string, on: boolean) => {
    if (!selectable) return;
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelect(next);
  };
  return (
    <Table>
      <THead>
        <TR>
          {selectable && (
            <TH className="w-8">
              <Checkbox
                aria-label="Select all orders on this page"
                checked={allSelected}
                onCheckedChange={(v) =>
                  onSelect(
                    v === true
                      ? new Set([...selected, ...orders.map((o) => o.id)])
                      : new Set([...selected].filter((id) => !orders.some((o) => o.id === id))),
                  )
                }
              />
            </TH>
          )}
          <TH>Order</TH>
          {showCustomer && <TH>Customer</TH>}
          <TH className="text-right">Items</TH>
          <TH className="text-right">Total</TH>
          <TH>Payment</TH>
          <TH>Status</TH>
          {showCourier && <TH>Courier</TH>}
        </TR>
      </THead>
      <TBody>
        {orders.map((o) => (
          <TR key={o.id} data-state={selected?.has(o.id) ? 'selected' : undefined}>
            {selectable && (
              <TD>
                <Checkbox
                  aria-label={`Select order ${o.number}`}
                  checked={selected.has(o.id)}
                  onCheckedChange={(v) => toggle(o.id, v === true)}
                />
              </TD>
            )}
            <TD>
              <Link
                href={`/app/${orgId}/orders/${o.id}`}
                className="font-mono font-medium text-primary hover:underline"
              >
                {o.number}
              </Link>
              <span className="block text-xs whitespace-nowrap text-muted-foreground">
                {formatDateTime(o.placedAt, timezone)}
              </span>
            </TD>
            {showCustomer && (
              <TD>
                <span className="block max-w-48 truncate">{o.customer.name}</span>
                <span className="text-xs text-muted-foreground">{o.customer.phone}</span>
                <PhoneRisk risk={o.customer.phone ? risk?.get(o.customer.phone) : undefined} />
              </TD>
            )}
            <TD className="tabular text-right">{o.items.reduce((a, i) => a + i.quantity, 0)}</TD>
            <TD className="tabular text-right whitespace-nowrap">
              {formatMoney(o.totalMinor, o.currency)}
            </TD>
            <TD>
              <span className="flex flex-wrap gap-1">
                <PaymentBadge status={o.payment.status} />
                <OnlinePaymentBadge online={o.payment.online} />
              </span>
            </TD>
            <TD>
              <OrderStatusBadge status={o.status} />
            </TD>
            {showCourier && (
              <TD>
                {o.shipment ? (
                  <>
                    <ShipmentBadge status={o.shipment.status} attention={o.shipment.attention} />
                    <span className="block text-xs text-muted-foreground">
                      {o.shipment.accountName}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground" aria-label="Not sent">
                    —
                  </span>
                )}
              </TD>
            )}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
