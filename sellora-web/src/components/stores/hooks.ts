'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { Store, StoreList, ThemeCatalog } from '@/lib/api/types';

export const storeKeys = {
  all: (orgId: string) => ['org', orgId, 'stores'] as const,
  store: (orgId: string, id: string) => ['org', orgId, 'stores', id] as const,
  themes: (orgId: string) => ['org', orgId, 'stores', 'themes'] as const,
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
