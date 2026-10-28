import { CheckCircle2, Circle, ExternalLink, Truck } from 'lucide-react';
import type { Dictionary } from '@/lib/i18n';
import { formatDate } from '@/lib/money';
import type { Language, Shipment } from '@/lib/types';
import { cn } from '@/lib/cn';

const FLOW = ['pending', 'confirmed', 'packed', 'shipped', 'delivered'];

/** Where the order is: the usual steps, then the courier's parcel when there is one. */
export function OrderProgress({
  status,
  timeline,
  shipment,
  language,
  t,
}: {
  status: string;
  timeline: { status: string; at: string }[];
  shipment: Shipment | null;
  language: Language;
  t: Dictionary;
}) {
  const ended = status === 'cancelled' || status === 'returned';
  const reached = new Map(timeline.map((s) => [s.status, s.at]));
  const steps = ended ? [...FLOW.filter((s) => reached.has(s)), status] : FLOW;
  return (
    <div className="space-y-5">
      <ol className="space-y-3">
        {steps.map((s) => {
          const at = reached.get(s);
          const done = Boolean(at);
          return (
            <li key={s} className="flex items-start gap-3">
              {done ? (
                <CheckCircle2
                  className={cn(
                    'mt-0.5 size-5 shrink-0',
                    ended && s === status ? 'text-red-700' : 'text-primary',
                  )}
                  aria-hidden="true"
                />
              ) : (
                <Circle className="mt-0.5 size-5 shrink-0 text-line" aria-hidden="true" />
              )}
              <div>
                <p className={cn('text-sm font-medium', !done && 'text-muted')}>
                  {t.statuses[s] ?? s}
                </p>
                {at ? <p className="text-xs text-muted">{formatDate(at, language)}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {shipment ? (
        <div className="rounded-store border border-line bg-tint p-4 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <Truck className="size-4" aria-hidden="true" />
            {t.shipmentStatuses[shipment.status] ?? shipment.status}
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted">{t.courier}</dt>
            <dd>{shipment.courier}</dd>
            {shipment.trackingCode ? (
              <>
                <dt className="text-muted">{t.trackingCode}</dt>
                <dd className="font-mono">{shipment.trackingCode}</dd>
              </>
            ) : null}
          </dl>
          {shipment.trackingUrl ? (
            <a
              href={shipment.trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              {t.trackWithCourier}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
