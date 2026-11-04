'use client';

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { AbandonedCart, CartSettings, CartSummary, CartView, Page } from '@/lib/api/types';

export const cartKeys = {
  all: (orgId: string) => ['org', orgId, 'carts'] as const,
  settings: (orgId: string) => ['org', orgId, 'carts', 'settings'] as const,
  summary: (orgId: string) => ['org', orgId, 'carts', 'summary'] as const,
  lists: (orgId: string) => ['org', orgId, 'carts', 'list'] as const,
  list: (orgId: string, view: CartView, phone: string) =>
    ['org', orgId, 'carts', 'list', { view, phone }] as const,
};

export function useCartSettings(orgId: string, enabled = true) {
  return useQuery({
    queryKey: cartKeys.settings(orgId),
    queryFn: () => api<CartSettings>(`/orgs/${orgId}/carts/settings`),
    enabled,
  });
}

/** Saves part of the settings; the answer is the whole new settings, cached at once. */
export function useCartSettingsPatch(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (body: Record<string, unknown>) =>
      api<CartSettings>(`/orgs/${orgId}/carts/settings`, { method: 'PATCH', body }),
    onSuccess: (s) => {
      qc.setQueryData(cartKeys.settings(orgId), s);
      // Waiting carts were planned again: their next reminder time changed.
      void qc.invalidateQueries({ queryKey: cartKeys.lists(orgId) });
    },
  });
}

export function useCartSummary(orgId: string, enabled = true) {
  return useQuery({
    queryKey: cartKeys.summary(orgId),
    queryFn: () => api<CartSummary>(`/orgs/${orgId}/carts/summary`),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useCarts(orgId: string, view: CartView, phone: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: cartKeys.list(orgId, view, phone),
    queryFn: ({ pageParam }) =>
      api<Page<AbandonedCart>>(`/orgs/${orgId}/carts`, {
        query: { view, limit: 25, cursor: pageParam, phone: phone || undefined },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
    // Reminders go out on their own; the list follows within half a minute.
    refetchInterval: 30_000,
  });
}

/** "Send reminder now" and "Stop reminders": the answer is the cart as it is now. */
export function useCartAction(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ id, action }: { id: string; action: 'remind' | 'dismiss' }) =>
      api<AbandonedCart>(`/orgs/${orgId}/carts/${id}/${action}`, { method: 'POST' }),
    onSuccess: (cart) => {
      qc.setQueriesData<InfiniteData<Page<AbandonedCart>>>(
        { queryKey: cartKeys.lists(orgId) },
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((p) => ({
              ...p,
              items: p.items.map((c) => (c.id === cart.id ? cart : c)),
            })),
          },
      );
      void qc.invalidateQueries({ queryKey: cartKeys.summary(orgId) });
      void qc.invalidateQueries({ queryKey: cartKeys.lists(orgId), refetchType: 'none' });
    },
  });
}
