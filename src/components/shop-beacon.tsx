'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { noteVisit } from '@/lib/shop-steps';
import { useShop } from './shop-context';

/**
 * Counts the visit and remembers where the shopper came from, on every page of an open
 * store. Previews count nothing: the business and the reviewer are not shoppers.
 */
export function ShopBeacon() {
  const { state } = useShop();
  const pathname = usePathname();
  useEffect(() => {
    if (state === 'open') noteVisit();
  }, [state, pathname]);
  return null;
}
