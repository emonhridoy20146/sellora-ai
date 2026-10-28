'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type {
  LandingPage,
  LandingPageList,
  LandingStats,
  LandingTemplate,
  LandingVersion,
} from '@/lib/api/types';

export const landingKeys = {
  all: (orgId: string) => ['org', orgId, 'landing-pages'] as const,
  page: (orgId: string, id: string) => ['org', orgId, 'landing-pages', id] as const,
  versions: (orgId: string, id: string) => ['org', orgId, 'landing-pages', id, 'versions'] as const,
  stats: (orgId: string, id: string, days: number) =>
    ['org', orgId, 'landing-pages', id, 'stats', days] as const,
  templates: (orgId: string) => ['org', orgId, 'landing-pages', 'templates'] as const,
};

export function useLandingPages(orgId: string) {
  return useQuery({
    queryKey: landingKeys.all(orgId),
    queryFn: () => api<LandingPageList>(`/orgs/${orgId}/landing-pages`),
  });
}

export function useLandingPage(orgId: string, id: string) {
  return useQuery({
    queryKey: landingKeys.page(orgId, id),
    queryFn: () => api<LandingPage>(`/orgs/${orgId}/landing-pages/${id}`),
  });
}

export function useLandingVersions(orgId: string, id: string) {
  return useQuery({
    queryKey: landingKeys.versions(orgId, id),
    queryFn: () => api<{ items: LandingVersion[] }>(`/orgs/${orgId}/landing-pages/${id}/versions`),
  });
}

export function useLandingStats(orgId: string, id: string, days: number) {
  return useQuery({
    queryKey: landingKeys.stats(orgId, id, days),
    queryFn: () =>
      api<LandingStats>(`/orgs/${orgId}/landing-pages/${id}/stats`, { query: { days } }),
  });
}

export function useLandingTemplates(orgId: string) {
  return useQuery({
    queryKey: landingKeys.templates(orgId),
    queryFn: () => api<{ items: LandingTemplate[] }>(`/orgs/${orgId}/landing-pages/templates`),
    staleTime: 30 * 60_000,
  });
}
