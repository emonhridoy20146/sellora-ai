'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type {
  ContentDraft,
  KeywordListDetail,
  KeywordListSummary,
  KeywordResearch,
  KeywordSetup,
  SearchConsoleState,
  SeoAudit,
  SeoBulkRun,
} from '@/lib/api/types';

export const seoKeys = {
  all: (orgId: string) => ['org', orgId, 'seo'] as const,
  audit: (orgId: string) => ['org', orgId, 'seo', 'audit'] as const,
  bulk: (orgId: string) => ['org', orgId, 'seo', 'bulk'] as const,
  bulkRun: (orgId: string, id: string) => ['org', orgId, 'seo', 'bulk', id] as const,
  setup: (orgId: string) => ['org', orgId, 'seo', 'keywords', 'setup'] as const,
  research: (orgId: string) => ['org', orgId, 'seo', 'keywords', 'research'] as const,
  lists: (orgId: string) => ['org', orgId, 'seo', 'keyword-lists'] as const,
  list: (orgId: string, id: string) => ['org', orgId, 'seo', 'keyword-lists', id] as const,
  console: (orgId: string, days: number) => ['org', orgId, 'seo', 'search-console', days] as const,
  drafts: (orgId: string) => ['org', orgId, 'seo', 'content'] as const,
};

export function useSeoAudit(orgId: string) {
  return useQuery({
    queryKey: seoKeys.audit(orgId),
    queryFn: () => api<SeoAudit>(`/orgs/${orgId}/seo/audit`),
  });
}

export function useBulkRuns(orgId: string) {
  return useQuery({
    queryKey: seoKeys.bulk(orgId),
    queryFn: () => api<{ items: SeoBulkRun[] }>(`/orgs/${orgId}/seo/bulk`),
    // A run writes in the background: check every few seconds while one is going.
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => r.status === 'queued' || r.status === 'running')
        ? 3000
        : false,
  });
}

export function useKeywordSetup(orgId: string) {
  return useQuery({
    queryKey: seoKeys.setup(orgId),
    queryFn: () => api<KeywordSetup>(`/orgs/${orgId}/seo/keywords/setup`),
  });
}

export function useResearchHistory(orgId: string) {
  return useQuery({
    queryKey: seoKeys.research(orgId),
    queryFn: () => api<{ items: KeywordResearch[] }>(`/orgs/${orgId}/seo/keywords/research`),
  });
}

export function useKeywordLists(orgId: string) {
  return useQuery({
    queryKey: seoKeys.lists(orgId),
    queryFn: () =>
      api<{ items: KeywordListSummary[]; max: number }>(`/orgs/${orgId}/seo/keyword-lists`),
  });
}

export function useKeywordList(orgId: string, id: string | null) {
  return useQuery({
    queryKey: seoKeys.list(orgId, id ?? ''),
    queryFn: () => api<KeywordListDetail>(`/orgs/${orgId}/seo/keyword-lists/${id}`),
    enabled: Boolean(id),
  });
}

export function useSearchConsole(orgId: string, days: 7 | 28 | 90) {
  return useQuery({
    queryKey: seoKeys.console(orgId, days),
    queryFn: () =>
      api<SearchConsoleState>(`/orgs/${orgId}/seo/search-console`, { query: { days } }),
    // While Google is being set up, check again until it is done or stuck.
    refetchInterval: (q) => {
      const c = q.state.data?.connection;
      return c && c.status === 'connected' && (c.step !== 'done' || !c.lastSyncAt) && !c.setupError
        ? 5000
        : false;
    },
  });
}

export function useContentDrafts(orgId: string) {
  return useQuery({
    queryKey: seoKeys.drafts(orgId),
    queryFn: () => api<{ items: ContentDraft[] }>(`/orgs/${orgId}/seo/content`),
  });
}
