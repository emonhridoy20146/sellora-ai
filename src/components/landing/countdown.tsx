'use client';

import { useSyncExternalStore } from 'react';
import { countdownParts } from '@/lib/landing-offer';
import { formatNumber } from '@/lib/money';
import type { Language } from '@/lib/types';

/** One shared one-second clock for every countdown on the page. */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// The same value until the clock ticks, as useSyncExternalStore requires.
const clientNow = () => {
  if (!now) now = Date.now();
  return now;
};
// The server cannot know the shopper's clock: it renders the boxes empty, the browser fills them.
const serverNow = () => null;

/** Days, hours, minutes and seconds to the offer's end; the page's own words once it ended. */
export function Countdown({
  endsAt,
  endedText,
  units,
  language,
}: {
  endsAt: string;
  endedText: string;
  units: { days: string; hours: string; minutes: string; seconds: string };
  language: Language;
}) {
  const at = useSyncExternalStore(subscribe, clientNow, serverNow);
  const parts = at === null ? undefined : countdownParts(endsAt, at);
  if (parts === null)
    return endedText ? <p className="text-lg font-semibold">{endedText}</p> : null;
  const boxes = [
    { key: 'days', label: units.days, value: parts?.days },
    { key: 'hours', label: units.hours, value: parts?.hours },
    { key: 'minutes', label: units.minutes, value: parts?.minutes },
    { key: 'seconds', label: units.seconds, value: parts?.seconds },
  ];
  return (
    <div className="flex justify-center gap-2 sm:gap-3" role="timer" aria-live="off">
      {boxes.map((b) => (
        <div key={b.key} className="w-16 rounded-store bg-white/10 px-2 py-3 sm:w-20">
          <span className="block font-display text-2xl font-bold tabular-nums sm:text-3xl">
            {b.value === undefined
              ? '–'
              : formatNumber(b.value, language).padStart(2, language === 'bn' ? '০' : '0')}
          </span>
          <span className="mt-1 block text-xs text-white/75">{b.label}</span>
        </div>
      ))}
    </div>
  );
}
