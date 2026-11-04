'use client';

import { useEffect, useRef } from 'react';

/**
 * Abandoned cart reminders (API ADR 0018). When the business has them on, the checkout and
 * landing order forms send the cart a moment after the shopper has typed a valid mobile
 * number, so the business can text a reminder with a link back to it. The cart is known
 * by a random token kept in this browser; the order sends the token too, which closes it.
 */

const SAVE_AFTER_MS = 1500;

export { landingCartTokenKey, storeCartTokenKey } from './cart-keys';

function random(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** The token for this cart, made on first use. Null when storage is blocked. */
export function cartToken(key: string, create = true): string | null {
  try {
    const found = localStorage.getItem(key);
    if (found && /^[A-Za-z0-9_-]{16,64}$/.test(found)) return found;
    if (!create) return null;
    const made = random();
    localStorage.setItem(key, made);
    return made;
  } catch {
    return null;
  }
}

export function setCartToken(key: string, token: string | null): void {
  try {
    if (token) localStorage.setItem(key, token);
    else localStorage.removeItem(key);
  } catch {
    // Storage is optional: without it no cart is saved.
  }
}

/**
 * Sends `body` (with the cart token) to `endpoint` once the shopper stops typing, and again
 * whenever it changes. Nothing is sent while `body` is null. Failures are ignored: saving a
 * cart never gets in the way of ordering.
 */
export function useCartCapture(endpoint: string, tokenKey: string, body: object | null): void {
  const last = useRef<string | null>(null);
  const json = body ? JSON.stringify(body) : null;
  useEffect(() => {
    if (!json || json === last.current) return;
    const timer = window.setTimeout(() => {
      const token = cartToken(tokenKey);
      if (!token) return;
      last.current = json;
      // The answer is read (and dropped): a response left unread keeps the request open.
      fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, ...(JSON.parse(json) as object) }),
      })
        .then((r) => r.text())
        .catch(() => undefined);
    }, SAVE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [endpoint, tokenKey, json]);
}
