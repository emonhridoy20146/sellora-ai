'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type {
  Page,
  SmsMessage,
  SmsMessageStatus,
  SmsOptOut,
  SmsSettings,
  SmsSummary,
} from '@/lib/api/types';

export const smsKeys = {
  all: (orgId: string) => ['org', orgId, 'sms'] as const,
  settings: (orgId: string) => ['org', orgId, 'sms', 'settings'] as const,
  summary: (orgId: string) => ['org', orgId, 'sms', 'summary'] as const,
  messages: (orgId: string, filter: Record<string, string | undefined>) =>
    ['org', orgId, 'sms', 'messages', filter] as const,
  optOuts: (orgId: string) => ['org', orgId, 'sms', 'opt-outs'] as const,
};

export function useSmsSettings(orgId: string, enabled = true) {
  return useQuery({
    queryKey: smsKeys.settings(orgId),
    queryFn: () => api<SmsSettings>(`/orgs/${orgId}/sms`),
    enabled,
  });
}

/** Saves part of the settings; the answer is the whole new settings, cached at once. */
export function useSmsSettingsPatch(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (body: Record<string, unknown>) =>
      api<SmsSettings>(`/orgs/${orgId}/sms`, { method: 'PATCH', body }),
    onSuccess: (s) => qc.setQueryData(smsKeys.settings(orgId), s),
  });
}

export function useSmsSummary(orgId: string, enabled = true) {
  return useQuery({
    queryKey: smsKeys.summary(orgId),
    queryFn: () => api<SmsSummary>(`/orgs/${orgId}/sms/summary`),
    enabled,
  });
}

export function useSmsMessages(
  orgId: string,
  filter: { status?: SmsMessageStatus | ''; orderId?: string },
  opts: { limit?: number; enabled?: boolean; refetchInterval?: number | false } = {},
) {
  const status = filter.status || undefined;
  return useInfiniteQuery({
    queryKey: smsKeys.messages(orgId, { status, orderId: filter.orderId }),
    queryFn: ({ pageParam }) =>
      api<Page<SmsMessage>>(`/orgs/${orgId}/sms/messages`, {
        query: { limit: opts.limit ?? 20, cursor: pageParam, status, orderId: filter.orderId },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval ?? false,
  });
}

export function useSmsOptOuts(orgId: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: smsKeys.optOuts(orgId),
    queryFn: ({ pageParam }) =>
      api<Page<SmsOptOut>>(`/orgs/${orgId}/sms/opt-outs`, {
        query: { limit: 20, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}
