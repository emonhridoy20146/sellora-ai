'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { addLine, parseCart, setLineQuantity, type CartItem } from './cart-lines';

export { MAX_LINES, MAX_QUANTITY, type CartItem } from './cart-lines';

const EMPTY: CartItem[] = [];
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; items: CartItem[] }>();

const storageKey = (storeId: string) => `sl_cart_${storeId}`;

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readCart(storeId: string): CartItem[] {
  if (typeof window === 'undefined') return EMPTY;
  const key = storageKey(storeId);
  const raw = safeGet(key);
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.items;
  const items = raw ? parseCart(raw) : EMPTY;
  cache.set(key, { raw, items });
  return items;
}

function writeCart(storeId: string, items: CartItem[]): void {
  try {
    if (items.length) window.localStorage.setItem(storageKey(storeId), JSON.stringify(items));
    else window.localStorage.removeItem(storageKey(storeId));
  } catch {
    // Private mode or full storage: the cart lasts for this page only.
    cache.set(storageKey(storeId), { raw: JSON.stringify(items), items });
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** The cart for this store, shared by every component and browser tab. */
export function useCart(storeId: string) {
  const items = useSyncExternalStore(
    subscribe,
    () => readCart(storeId),
    () => EMPTY,
  );

  const add = useCallback(
    (item: CartItem) => {
      const next = addLine(readCart(storeId), item);
      writeCart(storeId, next);
    },
    [storeId],
  );

  const setQuantity = useCallback(
    (variantId: string, quantity: number) => {
      writeCart(storeId, setLineQuantity(readCart(storeId), variantId, quantity));
    },
    [storeId],
  );

  const remove = useCallback(
    (variantId: string) =>
      writeCart(
        storeId,
        readCart(storeId).filter((i) => i.variantId !== variantId),
      ),
    [storeId],
  );

  const clear = useCallback(() => writeCart(storeId, []), [storeId]);

  return {
    items,
    count: items.reduce((a, i) => a + i.quantity, 0),
    add,
    setQuantity,
    remove,
    clear,
  };
}
