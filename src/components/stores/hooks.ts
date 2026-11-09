'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { Store, StoreList, StoreStats, ThemeCatalog } from '@/lib/api/types';

export const storeKeys = {
  all: (orgId: string) => ['org', orgId, 'stores'] as const,
  store: (orgId: string, id: string) => ['org', orgId, 'stores', id] as const,
  themes: (orgId: string) => ['org', orgId, 'stores', 'themes'] as const,
  stats: (orgId: string, id: string, days: number) =>
    ['org', orgId, 'stores', id, 'stats', days] as const,
};

export function useStores(orgId: string) {
  return useQuery({
    queryKey: storeKeys.all(orgId),
    queryFn: () => api<StoreList>(`/orgs/${orgId}/stores`),
  });
}

export function useStore(orgId: string, id: string) {
  return useQuery({
    queryKey: storeKeys.store(orgId, id),
    queryFn: () => api<Store>(`/orgs/${orgId}/stores/${id}`),
  });
}

export function useThemes(orgId: string) {
  return useQuery({
    queryKey: storeKeys.themes(orgId),
    queryFn: () => api<ThemeCatalog>(`/orgs/${orgId}/stores/themes`),
    staleTime: 10 * 60_000,
  });
}

export function useStoreStats(orgId: string, id: string, days: number) {
  return useQuery({
    queryKey: storeKeys.stats(orgId, id, days),
    queryFn: () => api<StoreStats>(`/orgs/${orgId}/stores/${id}/stats`, { query: { days } }),
  });
}
