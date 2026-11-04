import { Badge } from '@/components/ui/badge';
import type { OrderPaymentStatus, OrderStatus, ProductStatus } from '@/lib/api/types';
import { ORDER_STATUS, PAYMENT_STATUS } from '@/lib/commerce';

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const s = ORDER_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function PaymentBadge({ status }: { status: OrderPaymentStatus }) {
  const s = PAYMENT_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function ProductStatusBadge({ status }: { status: ProductStatus }) {
  if (status === 'active') return <Badge tone="success">Active</Badge>;
  if (status === 'draft') return <Badge tone="warning">Draft</Badge>;
  return <Badge tone="neutral">Archived</Badge>;
}

/** Stock level with words, so the meaning never depends on color. */
export function StockBadge({
  tracked,
  stock,
  threshold,
}: {
  tracked: boolean;
  stock: number;
  threshold: number;
}) {
  if (!tracked) return <span className="text-muted-foreground">Not tracked</span>;
  if (stock <= 0) return <Badge tone="danger">Out of stock</Badge>;
  if (stock <= threshold) return <Badge tone="warning">{stock} left</Badge>;
  return <span className="tabular">{stock}</span>;
}
