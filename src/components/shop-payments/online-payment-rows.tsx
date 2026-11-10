'use client';

import { useQuery } from '@tanstack/react-query';
import { commerceKeys } from '@/components/commerce/hooks';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import type { OnlinePaymentAttempt, Order } from '@/lib/api/types';
import { formatDateTime, formatMoney } from '@/lib/format';
import {
  ATTEMPT_STATUS,
  SHOP_GATEWAY_NAME,
  attemptReason,
  onlinePaymentBadge,
} from '@/lib/shop-payments';

/**
 * What the shopper was asked to pay online at checkout, and each try with the gateway. Shown
 * in the order's payment card; nothing for orders without an online payment.
 */
export function OnlinePaymentRows({ order }: { order: Order }) {
  const { org } = useOrg();
  const online = order.payment.online;
  const attempts = useQuery({
    queryKey: [...commerceKeys.order(org.id, order.id), 'online-payments'],
    queryFn: () =>
      api<{ items: OnlinePaymentAttempt[] }>(
        `/orgs/${org.id}/orders/${order.id}/online-payments`,
      ).then((r) => r.items),
    enabled: Boolean(online),
  });
  if (!online) return null;
  const badge = onlinePaymentBadge(online);
  return (
    <div className="mt-3 grid gap-2 border-t pt-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {online.purpose === 'advance' ? 'Advance online' : 'Paid at checkout'}
        </span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className="text-muted-foreground">
        {formatMoney(online.dueMinor, order.currency)} with {SHOP_GATEWAY_NAME[online.gateway]}
        {online.purpose === 'advance' ? ', the rest in cash on delivery' : ''}
        {online.paidAt ? ` · paid ${formatDateTime(online.paidAt, org.timezone)}` : ''}.
      </p>
      {online.sandbox && (
        <Alert tone="warning">
          Test payment through the gateway’s sandbox. No real money moved; do not send the parcel on
          the strength of it.
        </Alert>
      )}
      {online.status === 'awaiting' && (
        <p className="text-[13px] text-muted-foreground">
          Sellora checks with the gateway every few minutes for two days, so a payment the shopper
          made shows here even if they never came back to the shop.
        </p>
      )}
      {attempts.isPending ? (
        <Skeleton className="h-12" />
      ) : attempts.isError ? (
        <p className="text-[13px] text-muted-foreground">Could not load the payment tries.</p>
      ) : (
        <ul className="grid gap-2" aria-label="Payment tries">
          {attempts.data.map((a) => {
            const s = ATTEMPT_STATUS[a.status];
            return (
              <li key={a.id} className="grid gap-0.5 rounded-md border px-2.5 py-2">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {a.gatewayName} ·{' '}
                    <span className="tabular">{formatMoney(a.amountMinor, a.currency)}</span>
                  </span>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(a.createdAt, org.timezone)}
                  {a.gatewayRef ? ` · ${a.gatewayRef}` : ''}
                  {a.status === 'cancelled' && !a.settled ? ' · checking with the gateway' : ''}
                </span>
                {a.reason && a.status !== 'succeeded' && (
                  <span className="text-xs text-muted-foreground">{attemptReason(a.reason)}</span>
                )}
                <span className="font-mono text-[11px] text-muted-foreground">{a.ref}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
