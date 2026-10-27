'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { BillingSummary, Me, PlatformMe } from './types';

/** Query keys in one place so a mutation can invalidate exactly what it changed. */
export const qk = {
  me: ['me'] as const,
  org: (orgId: string) => ['org', orgId] as const,
  billing: (orgId: string) => ['org', orgId, 'billing'] as const,
  platformMe: ['platform', 'me'] as const,
  platform: (...parts: (string | number | undefined)[]) => ['platform', ...parts] as const,
};

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: () => api<Me>('/auth/me') });
}

export function useBillingSummary(orgId: string, enabled = true) {
  return useQuery({
    queryKey: [...qk.billing(orgId), 'summary'],
    queryFn: () => api<BillingSummary>(`/orgs/${orgId}/billing/summary`),
    enabled,
  });
}

export function usePlatformMe() {
  return useQuery({ queryKey: qk.platformMe, queryFn: () => api<PlatformMe>('/platform/auth/me') });
}
