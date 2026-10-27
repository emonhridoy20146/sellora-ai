'use client';

import { createContext, useContext } from 'react';
import type { PlatformMe } from '@/lib/api/types';

const PlatformContext = createContext<{ me: PlatformMe; can: (p: string) => boolean } | null>(null);
export const PlatformProvider = PlatformContext.Provider;

export function usePlatform() {
  const ctx = useContext(PlatformContext);
  if (!ctx) throw new Error('usePlatform must be used inside the admin panel');
  return ctx;
}
