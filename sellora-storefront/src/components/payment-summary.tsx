import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Dictionary } from '@/lib/i18n';
import { paymentLabel, returnMessage } from '@/lib/payments';
import type { Receipt, ReturnState } from '@/lib/types';

/** The receipt's payment rows: how it is paid, what is paid and what is left for delivery. */
export function PaymentRows({
  order,
  t,
  money,
}: {
  order: Receipt;
  t: Dictionary;
  money: (minor: number) => string;
}) {
  const p = order.payment;
  return (
    <>
      <div className="flex justify-between gap-3 text-muted">
        <dt>{t.payment}</dt>
        <dd className="text-right">{paymentLabel(order, t)}</dd>
      </div>
      {p && p.paidMinor > 0 && p.status !== 'refunded' ? (
        <>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">{t.paidSoFar}</dt>
            <dd>{money(p.paidMinor)}</dd>
          </div>
          {p.dueMinor > 0 ? (
            <div className="flex justify-between gap-3 font-medium">
              <dt>{t.toPayOnDelivery}</dt>
              <dd>{money(p.dueMinor)}</dd>
            </div>
          ) : null}
        </>
      ) : null}
      {p?.online?.sandbox ? <p className="pt-1 text-xs text-muted">{t.testModeNote}</p> : null}
    </>
  );
}

/** What happened at the gateway, at the top of the receipt; nothing without a `?payment=`. */
export function PaymentBanner({
  order,
  state,
  t,
}: {
  order: Receipt;
  state: ReturnState | null;
  t: Dictionary;
}) {
  const m = returnMessage(state, order.payment, t);
  if (!m) return null;
  const Icon = m.tone === 'good' ? CheckCircle2 : m.tone === 'wait' ? Clock : XCircle;
  return (
    <p
      role="status"
      className={cn(
        'mb-6 flex items-start gap-3 rounded-store-lg border p-4 text-sm font-medium',
        m.tone === 'good' && 'border-primary bg-tint',
        m.tone === 'wait' && 'border-line bg-surface',
        m.tone === 'bad' && 'border-red-600 bg-surface',
      )}
    >
      <Icon
        className={cn('size-5 shrink-0', m.tone === 'bad' ? 'text-red-700' : 'text-primary')}
        aria-hidden="true"
      />
      {m.text}
    </p>
  );
}
