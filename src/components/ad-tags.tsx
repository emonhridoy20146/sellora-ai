'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  browserIds,
  CONSENT_KEY,
  hasTags,
  mayTrack,
  newEventId,
  PURCHASES_KEY,
  purchaseIsFresh,
  readConsent,
  reportedPurchases,
  type AdBrowserEvent,
  type AdBrowserIds,
  type AdItem,
} from '@/lib/ad-tags';
import { loadTags, pageView, reportEvent, reportPurchase } from '@/lib/ad-tags-browser';
import { dictionary } from '@/lib/i18n';
import { visitorId } from '@/lib/shop-steps';
import { readRaw } from '@/lib/shopper';
import type { AdTags, BrowserPurchase, Language } from '@/lib/types';

interface AdTagsApi {
  /** Reports a product view, add to cart or checkout start (browser tags and server copy). */
  track: (event: AdBrowserEvent, items: AdItem[]) => void;
  /** What goes with an order: the tag cookies and page, or only that the shopper said no. */
  ids: () => AdBrowserIds | undefined;
  /** Reports the purchase from the receipt, once per order in this browser. */
  purchase: (p: BrowserPurchase, placedAt: string) => void;
}

const NONE: AdTagsApi = { track: () => {}, ids: () => undefined, purchase: () => {} };
const AdTagsContext = createContext<AdTagsApi>(NONE);

/** The ad tags of the page, or nothing (previews, no tags, or outside a provider). */
export function useAdTags(): AdTagsApi {
  return useContext(AdTagsContext);
}

// The shopper's choice, shared by every part of the page and kept in this browser.
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const readChoice = () => readConsent(readRaw(CONSENT_KEY));
function choose(v: 'yes' | 'no') {
  try {
    localStorage.setItem(CONSENT_KEY, v);
  } catch {
    // Without storage the banner asks again on the next visit.
  }
  listeners.forEach((fn) => fn());
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}${Math.random()}`;
  }
}

/**
 * The business's own ad tags on a store or landing page (ADR 0030). When the business asks
 * shoppers first, nothing loads and nothing about the shopper is sent until they agree.
 */
export function AdTagsProvider({
  tags,
  endpoint,
  currency,
  language,
  children,
}: {
  tags: AdTags | null | undefined;
  /** Where the server copies of browser events go (this app's own route). */
  endpoint: string;
  currency: string;
  language: Language;
  children: React.ReactNode;
}) {
  const choice = useSyncExternalStore(subscribe, readChoice, () => null);
  const allowed = mayTrack(tags, choice);
  const pathname = usePathname();
  const shownPath = useRef<string | null>(null);

  /**
   * Loads the tags (once) and reports the first page view. Called before any event too:
   * a child's effect (a product view) runs before this provider's own.
   */
  const ensureLoaded = useCallback((): boolean => {
    if (!allowed || !tags) return false;
    loadTags(tags);
    if (shownPath.current === null) {
      shownPath.current = window.location.pathname;
      pageView(tags);
    }
    return true;
  }, [allowed, tags]);

  // Load once allowed; report page views as the shopper moves around.
  useEffect(() => {
    if (!ensureLoaded() || !tags) return;
    if (shownPath.current !== pathname) {
      shownPath.current = pathname;
      pageView(tags);
    }
  }, [ensureLoaded, tags, pathname]);

  const ids = useCallback((): AdBrowserIds | undefined => {
    if (!hasTags(tags)) return undefined;
    return browserIds(tags, allowed, {
      cookie: document.cookie,
      url: window.location.href,
      referrer: document.referrer,
      visitorId: visitorId(),
    });
  }, [tags, allowed]);

  const track = useCallback(
    (event: AdBrowserEvent, items: AdItem[]) => {
      if (!tags || !items.length || !ensureLoaded()) return;
      const eventId = newEventId(event, randomId);
      reportEvent(tags, event, eventId, items, currency);
      // The server copy goes only to tags with a server key; the API decides which.
      if (!tags.meta.length && !tags.tiktok.length) return;
      void fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event,
          eventId,
          items: items.slice(0, 30).map((i) => ({
            productId: i.productId,
            ...(i.variantId ? { variantId: i.variantId } : {}),
            quantity: i.quantity,
          })),
          ...ids(),
        }),
        keepalive: true,
      })
        .then((res) => res.text())
        .catch(() => {
          // Tracking is best effort: a lost event is never shown to the shopper.
        });
    },
    [tags, currency, endpoint, ids, ensureLoaded],
  );

  const purchase = useCallback(
    (p: BrowserPurchase, placedAt: string) => {
      if (!tags || !purchaseIsFresh(placedAt) || !ensureLoaded()) return;
      const done = reportedPurchases(readRaw(PURCHASES_KEY));
      if (done.includes(p.eventId)) return;
      try {
        localStorage.setItem(PURCHASES_KEY, JSON.stringify([...done, p.eventId].slice(-50)));
      } catch {
        // Without storage a reload may report it again; the platforms keep the first.
      }
      reportPurchase(tags, p);
    },
    [tags, ensureLoaded],
  );

  const api = useMemo<AdTagsApi>(() => ({ track, ids, purchase }), [track, ids, purchase]);
  return (
    <AdTagsContext.Provider value={hasTags(tags) ? api : NONE}>
      {children}
      {hasTags(tags) && tags.consent === 'ask' && choice === null ? (
        <ConsentBanner language={language} />
      ) : null}
    </AdTagsContext.Provider>
  );
}

function ConsentBanner({ language }: { language: Language }) {
  const t = dictionary(language);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div
      role="region"
      aria-label={t.consentTitle}
      className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl rounded-store-lg border border-line bg-surface p-4 text-sm shadow-lg"
    >
      <p className="font-medium">{t.consentTitle}</p>
      <p className="mt-1 text-muted">{t.consentText}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => choose('yes')}
          className="inline-flex h-10 items-center rounded-store bg-primary px-4 font-semibold text-on-primary hover:opacity-90"
        >
          {t.consentAccept}
        </button>
        <button
          type="button"
          onClick={() => {
            choose('no');
            setHidden(true);
          }}
          className="inline-flex h-10 items-center rounded-store border border-line px-4 font-medium"
        >
          {t.consentDecline}
        </button>
      </div>
    </div>
  );
}

/** On a receipt or thank-you page: reports the purchase to the tags that count it now. */
export function AdPurchase({
  purchase,
  placedAt,
}: {
  purchase: BrowserPurchase | undefined;
  placedAt: string;
}) {
  const { purchase: report } = useAdTags();
  useEffect(() => {
    if (purchase) report(purchase, placedAt);
  }, [purchase, placedAt, report]);
  return null;
}
