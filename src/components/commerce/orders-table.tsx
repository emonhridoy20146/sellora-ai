'use client';

import Link from 'next/link';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import type { Order } from '@/lib/api/types';
import { formatDateTime, formatMoney } from '@/lib/format';
import { OrderStatusBadge, PaymentBadge } from './badges';

/** Orders as a table; with `selected`, rows get checkboxes for bulk printing. */
export function OrdersTable({
  orgId,
  orders,
  timezone,
  showCustomer = true,
  selected,
  onSelect,
}: {
  orgId: string;
  orders: Order[];
  timezone: string;
  showCustomer?: boolean;
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
              </TD>
            )}
            <TD className="tabular text-right">{o.items.reduce((a, i) => a + i.quantity, 0)}</TD>
            <TD className="tabular text-right whitespace-nowrap">
              {formatMoney(o.totalMinor, o.currency)}
            </TD>
            <TD>
              <PaymentBadge status={o.payment.status} />
            </TD>
            <TD>
              <OrderStatusBadge status={o.status} />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
