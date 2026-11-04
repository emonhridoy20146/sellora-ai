'use client';

import { useState } from 'react';
import { asciiDigits } from '@/lib/phone';
import { readJson } from '@/lib/problem';
import type { Tracking } from '@/lib/types';
import { formatMoney } from '@/lib/money';
import { OrderProgress } from './order-status';
import { useShop } from './shop-context';

export function TrackForm() {
  const { language, t } = useShop();
  const [number, setNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [result, setResult] = useState<Tracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (number.trim().length < 3 || phone.trim().length < 6) {
      setError(t.trackHint);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/track', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          number: asciiDigits(number.trim()),
          phone: asciiDigits(phone).replace(/[\s-]/g, ''),
        }),
      });
      const r = await readJson<Tracking>(res, t);
      if (r.ok) setResult(r.data);
      else {
        setResult(null);
        setError(r.problem.status === 404 ? t.trackNotFound : r.problem.detail);
      }
    } catch {
      setError(t.tryAgain);
    }
    setBusy(false);
  };

  return (
    <div className="space-y-6">
      <form
        onSubmit={submit}
        className="space-y-4 rounded-store-lg border border-line bg-surface p-5"
      >
        <p className="text-sm text-muted">{t.trackHint}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="track-number" className="mb-1.5 block text-sm font-medium">
              {t.orderNumber}
            </label>
            <input
              id="track-number"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="SL-1001"
              autoCapitalize="characters"
              className="h-11 w-full rounded-store border border-line bg-surface px-3"
            />
          </div>
          <div>
            <label htmlFor="track-phone" className="mb-1.5 block text-sm font-medium">
              {t.phone}
            </label>
            <input
              id="track-phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="01XXXXXXXXX"
              className="h-11 w-full rounded-store border border-line bg-surface px-3"
            />
          </div>
        </div>
        {error ? (
          <p className="text-sm text-red-700" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="h-11 rounded-store bg-primary px-6 font-semibold text-on-primary hover:opacity-90 disabled:opacity-50"
        >
          {t.trackButton}
        </button>
      </form>
      {result ? (
        <section className="rounded-store-lg border border-line bg-surface p-5" aria-live="polite">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">
              {t.orderNumber} {result.number}
            </h2>
            <p className="text-sm text-muted">
              {formatMoney(result.totalMinor, result.currency, language)}
            </p>
          </div>
          <OrderProgress
            status={result.status}
            timeline={result.timeline}
            shipment={result.shipment}
            language={language}
            t={t}
          />
        </section>
      ) : null}
    </div>
  );
}
