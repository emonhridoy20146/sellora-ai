'use client';

import { Banknote, CreditCard } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Dictionary } from '@/lib/i18n';
import type { PaymentPick } from '@/lib/payments';
import type { CheckoutPayments } from '@/lib/types';

/**
 * Cash on delivery (with an advance when the shop asks one) or paying everything online, and
 * the gateway to pay with. With no gateway switched on it is only the cash on delivery note.
 */
export function PaymentChoice({
  id,
  options,
  pick,
  onPick,
  money,
  t,
  error,
  bold,
}: {
  id: string;
  options: CheckoutPayments | undefined;
  pick: PaymentPick;
  onPick: (p: PaymentPick) => void;
  money: (minor: number) => string;
  t: Dictionary;
  error?: string | undefined;
  /** Landing pages use heavier borders and type. */
  bold?: boolean;
}) {
  const card = (active: boolean) =>
    cn(
      'flex cursor-pointer items-start gap-3 rounded-store p-3 text-sm',
      bold ? 'border-2' : 'border',
      active ? 'border-primary bg-tint' : 'border-line',
    );
  if (!options?.gateways.length)
    return (
      <div className="flex items-center gap-3 rounded-store bg-tint p-3">
        <Banknote className="size-5 shrink-0 text-primary" aria-hidden="true" />
        <p className="text-sm">
          <span className="font-semibold">{t.cod}.</span> {t.codHint}
        </p>
      </div>
    );

  const askGateway = pick.method === 'online' || options.advanceMinor > 0;
  const sandbox = options.gateways.some((g) => g.sandbox);
  return (
    <div className="grid gap-3">
      <div role="radiogroup" aria-label={t.payment} className="grid gap-2">
        {options.cod ? (
          <label className={card(pick.method === 'cod')}>
            <input
              type="radio"
              name={`${id}-method`}
              checked={pick.method === 'cod'}
              onChange={() => onPick({ ...pick, method: 'cod' })}
              className="mt-0.5 size-4 accent-(--primary)"
            />
            <Banknote className="size-5 shrink-0 text-primary" aria-hidden="true" />
            <span>
              <span className="block font-semibold">{t.cod}</span>
              <span className="block text-muted">
                {options.advanceMinor > 0
                  ? t.codAdvanceHint(money(options.advanceMinor))
                  : t.codHint}
              </span>
            </span>
          </label>
        ) : null}
        {options.fullOnline ? (
          <label className={card(pick.method === 'online')}>
            <input
              type="radio"
              name={`${id}-method`}
              checked={pick.method === 'online'}
              onChange={() => onPick({ ...pick, method: 'online' })}
              className="mt-0.5 size-4 accent-(--primary)"
            />
            <CreditCard className="size-5 shrink-0 text-primary" aria-hidden="true" />
            <span>
              <span className="block font-semibold">{t.payOnline}</span>
              <span className="block text-muted">{t.payOnlineHint}</span>
            </span>
          </label>
        ) : null}
      </div>
      {askGateway ? (
        <fieldset id={`${id}-gateway`} tabIndex={-1}>
          <legend className={cn('mb-2 text-sm', bold ? 'font-semibold' : 'font-medium')}>
            {pick.method === 'online' ? t.payWith : t.payAdvanceWith}
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {options.gateways.map((g) => (
              <label key={g.key} className={card(pick.gateway === g.key)}>
                <input
                  type="radio"
                  name={`${id}-gateway`}
                  checked={pick.gateway === g.key}
                  onChange={() => onPick({ ...pick, gateway: g.key })}
                  className="mt-0.5 size-4 accent-(--primary)"
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 font-semibold">
                    {g.name}
                    {g.sandbox ? (
                      <span className="rounded-full border border-line px-1.5 text-[11px] font-medium text-muted">
                        {t.testMode}
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-xs text-muted">{g.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {error ? <p className="mt-1 text-sm text-red-700">{error}</p> : null}
        </fieldset>
      ) : null}
      {askGateway && sandbox ? <p className="text-xs text-muted">{t.testModeNote}</p> : null}
    </div>
  );
}
