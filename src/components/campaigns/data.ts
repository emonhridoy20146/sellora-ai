'use client';

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type {
  AudienceCount,
  AutomationKind,
  AutomationSend,
  AutomationSettings,
  Campaign,
  CampaignAudience,
  CampaignOptions,
  CampaignRecipient,
  CampaignStatus,
  CampaignSummary,
  Page,
} from '@/lib/api/types';

export const campaignKeys = {
  all: (orgId: string) => ['org', orgId, 'campaigns'] as const,
  options: (orgId: string) => ['org', orgId, 'campaigns', 'options'] as const,
  lists: (orgId: string) => ['org', orgId, 'campaigns', 'list'] as const,
  list: (orgId: string, status: CampaignStatus | 'all') =>
    ['org', orgId, 'campaigns', 'list', status] as const,
  one: (orgId: string, id: string) => ['org', orgId, 'campaigns', 'one', id] as const,
  audience: (orgId: string, a: CampaignAudience) =>
    ['org', orgId, 'campaigns', 'audience', a] as const,
  recipients: (orgId: string, id: string, status: string) =>
    ['org', orgId, 'campaigns', 'one', id, 'recipients', status] as const,
  automations: (orgId: string) => ['org', orgId, 'automations'] as const,
  sends: (orgId: string, kind: AutomationKind | 'all') =>
    ['org', orgId, 'automations', 'sends', kind] as const,
};

/** Stores, live pages, tags, the SMS price, wallet cash and today's limit. */
export function useCampaignOptions(orgId: string, enabled = true) {
  return useQuery({
    queryKey: campaignKeys.options(orgId),
    queryFn: () => api<CampaignOptions>(`/orgs/${orgId}/campaigns/options`),
    enabled,
  });
}

export function useCampaigns(orgId: string, status: CampaignStatus | 'all', enabled = true) {
  return useInfiniteQuery({
    queryKey: campaignKeys.list(orgId, status),
    queryFn: ({ pageParam }) =>
      api<Page<CampaignSummary>>(`/orgs/${orgId}/campaigns`, {
        query: { status: status === 'all' ? undefined : status, limit: 25, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
    // Campaigns that are sending move on by themselves.
    refetchInterval: 30_000,
  });
}

export function useCampaign(orgId: string, id: string, enabled = true) {
  return useQuery({
    queryKey: campaignKeys.one(orgId, id),
    queryFn: () => api<Campaign>(`/orgs/${orgId}/campaigns/${id}`),
    enabled,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'sending' || s === 'scheduled' ? 10_000 : false;
    },
  });
}

/** Who an audience reaches now. */
export function useAudienceCount(orgId: string, audience: CampaignAudience, enabled = true) {
  return useQuery({
    queryKey: campaignKeys.audience(orgId, audience),
    queryFn: () =>
      api<AudienceCount>(`/orgs/${orgId}/campaigns/audience`, { method: 'POST', body: audience }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function useRecipients(orgId: string, id: string, status: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: campaignKeys.recipients(orgId, id, status),
    queryFn: ({ pageParam }) =>
      api<Page<CampaignRecipient>>(`/orgs/${orgId}/campaigns/${id}/recipients`, {
        query: { status: status === 'all' ? undefined : status, limit: 50, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** A campaign action whose answer is the campaign as it is now. */
export function useCampaignAction(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: 'start' | 'pause' | 'resume' | 'cancel' | 'duplicate';
      body?: Record<string, unknown>;
    }) =>
      api<Campaign>(`/orgs/${orgId}/campaigns/${id}/${action}`, {
        method: 'POST',
        body: body ?? {},
      }),
    onSuccess: (c) => {
      qc.setQueryData(campaignKeys.one(orgId, c.id), c);
      void qc.invalidateQueries({ queryKey: campaignKeys.lists(orgId) });
      void qc.invalidateQueries({ queryKey: campaignKeys.options(orgId) });
    },
  });
}

export function useAutomations(orgId: string, enabled = true) {
  return useQuery({
    queryKey: campaignKeys.automations(orgId),
    queryFn: () => api<AutomationSettings>(`/orgs/${orgId}/automations`),
    enabled,
  });
}

export function useAutomationsPatch(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (body: Record<string, unknown>) =>
      api<AutomationSettings>(`/orgs/${orgId}/automations`, { method: 'PATCH', body }),
    onSuccess: (s) => qc.setQueryData(campaignKeys.automations(orgId), s),
  });
}

export function useAutomationSends(orgId: string, kind: AutomationKind | 'all', enabled = true) {
  return useInfiniteQuery({
    queryKey: campaignKeys.sends(orgId, kind),
    queryFn: ({ pageParam }) =>
      api<Page<AutomationSend>>(`/orgs/${orgId}/automations/sends`, {
        query: { kind: kind === 'all' ? undefined : kind, limit: 25, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval: 60_000,
  });
}
