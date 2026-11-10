'use client';

import { CreditCard } from 'lucide-react';
import { useState } from 'react';
import { dictionary } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { readJson } from '@/lib/problem';
import type { Language, PaymentStart, ReceiptPayment } from '@/lib/types';

/**
 * "Pay now" on a receipt or thank-you page: what is still due online, with a gateway the
 * shopper picks. The API starts a fresh attempt and the shopper goes to the gateway's page.
 */
export function PayNow({
  receipt,
  payment,
  endpoint,
  currency,
  language,
}: {
  receipt: string;
  payment: ReceiptPayment;
  endpoint: string;
  currency: string;
  language: Language;
}) {
  const t = dictionary(language);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!payment.payNow) return null;
  const amount = formatMoney(payment.payNow.amountMinor, currency, language);
  const advance = payment.online?.purpose === 'advance';

  const pay = async (gateway: string) => {
    setBusy(gateway);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ receipt, gateway }),
      });
      const r = await readJson<PaymentStart>(res, t);
      if (r.ok && r.data.redirectUrl) {
        window.location.assign(r.data.redirectUrl);
        return;
      }
      setError(r.ok ? (r.data.error ?? t.tryAgain) : r.problem.detail);
    } catch {
      setError(t.tryAgain);
    }
    setBusy(null);
  };

  return (
    <section
      className="rounded-store-lg border-2 border-primary bg-surface p-5"
      aria-labelledby="pay-now-title"
    >
      <h2 id="pay-now-title" className="flex items-center gap-2 font-semibold">
        <CreditCard className="size-5 text-primary" aria-hidden="true" /> {t.payNowTitle}
      </h2>
      <p className="mt-1 text-sm text-muted">{advance ? t.payNowAdvance : t.payNowFull}</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {payment.payNow.gateways.map((g) => (
          <button
            key={g.key}
            type="button"
            disabled={busy !== null}
            onClick={() => void pay(g.key)}
            className="flex min-h-12 items-center justify-center gap-2 rounded-store bg-primary px-4 py-2 text-center font-semibold text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === g.key ? t.goingToPay : t.payAmountWith(amount, g.name)}
            {g.sandbox ? (
              <span className="rounded-full border border-current px-1.5 text-[11px] font-medium">
                {t.testMode}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {payment.payNow.gateways.some((g) => g.sandbox) ? (
        <p className="mt-2 text-xs text-muted">{t.testModeNote}</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-sm font-medium text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
