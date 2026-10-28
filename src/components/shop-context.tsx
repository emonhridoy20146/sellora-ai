'use client';

import { createContext, useContext } from 'react';
import { dictionary, type Dictionary } from '@/lib/i18n';
import type { Language, StoreState } from '@/lib/types';

interface Shop {
  storeId: string;
  name: string;
  language: Language;
  currency: string;
  state: StoreState;
  minOrderMinor: number;
  checkoutNote: string;
}

const ShopContext = createContext<Shop | null>(null);

/** What client components need to know about the store they are in. */
export function ShopProvider({ shop, children }: { shop: Shop; children: React.ReactNode }) {
  return <ShopContext.Provider value={shop}>{children}</ShopContext.Provider>;
}

export function useShop(): Shop & { t: Dictionary } {
  const shop = useContext(ShopContext);
  if (!shop) throw new Error('useShop outside ShopProvider');
  return { ...shop, t: dictionary(shop.language) };
}
