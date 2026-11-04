'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type {
  CourierAccount,
  CourierChoice,
  CourierDescriptor,
  CourierLocation,
  FraudBatch,
  FraudCheck,
  FraudSettings,
  Parcel,
} from '@/lib/api/types';
import { phoneBatches } from '@/lib/couriers';

export const courierKeys = {
  all: (orgId: string) => ['org', orgId, 'couriers'] as const,
  providers: (orgId: string) => ['org', orgId, 'couriers', 'providers'] as const,
  accounts: (orgId: string) => ['org', orgId, 'couriers', 'accounts'] as const,
  choices: (orgId: string) => ['org', orgId, 'couriers', 'choices'] as const,
  parcels: (orgId: string, orderId: string) =>
    ['org', orgId, 'couriers', 'parcels', orderId] as const,
  locations: (orgId: string, accountId: string, kind: string, parent?: number, q?: string) =>
    ['org', orgId, 'couriers', 'locations', accountId, kind, parent ?? 0, q ?? ''] as const,
};

export const fraudKeys = {
  all: (orgId: string) => ['org', orgId, 'fraud'] as const,
  check: (orgId: string, phone: string) => ['org', orgId, 'fraud', 'check', phone] as const,
  batch: (orgId: string, phones: string[]) =>
    ['org', orgId, 'fraud', 'batch', phones.join(',')] as const,
  settings: (orgId: string) => ['org', orgId, 'fraud', 'settings'] as const,
};

export function useCourierProviders(orgId: string, enabled = true) {
  return useQuery({
    queryKey: courierKeys.providers(orgId),
    queryFn: () =>
      api<{ items: CourierDescriptor[] }>(`/orgs/${orgId}/couriers/providers`).then((r) => r.items),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useCourierAccounts(orgId: string, enabled = true) {
  return useQuery({
    queryKey: courierKeys.accounts(orgId),
    queryFn: () =>
      api<{ items: CourierAccount[] }>(`/orgs/${orgId}/couriers/accounts`).then((r) => r.items),
    enabled,
  });
}

export function useCourierChoices(orgId: string, enabled = true) {
  return useQuery({
    queryKey: courierKeys.choices(orgId),
    queryFn: () =>
      api<{ items: CourierChoice[] }>(`/orgs/${orgId}/couriers/choices`).then((r) => r.items),
    staleTime: 30_000,
    enabled,
  });
}

/** The order's bookings, newest first. Polls while a booking is on its way to the courier. */
export function useOrderParcels(orgId: string, orderId: string, enabled = true) {
  return useQuery({
    queryKey: courierKeys.parcels(orgId, orderId),
    queryFn: () =>
      api<{ items: Parcel[] }>(`/orgs/${orgId}/orders/${orderId}/parcels`).then((r) => r.items),
    enabled,
    refetchInterval: (q) =>
      q.state.data?.some((p) => p.status === 'queued' || p.status === 'sending') ? 4000 : false,
  });
}

export function useCourierLocations(
  orgId: string,
  accountId: string,
  kind: 'city' | 'zone' | 'area',
  opts: { parent?: number; q?: string; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: courierKeys.locations(orgId, accountId, kind, opts.parent, opts.q),
    queryFn: () =>
      api<{ items: CourierLocation[] }>(`/orgs/${orgId}/couriers/accounts/${accountId}/locations`, {
        query: { kind, parent: opts.parent, q: opts.q },
      }).then((r) => r.items),
    staleTime: 10 * 60_000,
    enabled: opts.enabled ?? true,
  });
}

export function useFraudCheck(orgId: string, phone: string | null, enabled = true) {
  return useQuery({
    queryKey: fraudKeys.check(orgId, phone ?? ''),
    queryFn: () => api<FraudCheck>(`/orgs/${orgId}/fraud-check`, { query: { phone } }),
    enabled: enabled && Boolean(phone),
    staleTime: 60_000,
    retry: false,
  });
}

/** Risk levels for many numbers (order list badges), keyed by E.164 number. */
export function useFraudBatch(orgId: string, phones: (string | null)[], enabled = true) {
  const batches = phoneBatches(phones);
  const results = useQueries({
    queries: batches.map((b) => ({
      queryKey: fraudKeys.batch(orgId, b),
      queryFn: () => api<FraudBatch>(`/orgs/${orgId}/fraud-check/batch`, { body: { phones: b } }),
      enabled,
      staleTime: 60_000,
      retry: false,
    })),
  });
  const byPhone = new Map<string, FraudBatch['items'][number]>();
  for (const r of results) for (const item of r.data?.items ?? []) byPhone.set(item.phone, item);
  return byPhone;
}

export function useFraudSettings(orgId: string, enabled = true) {
  return useQuery({
    queryKey: fraudKeys.settings(orgId),
    queryFn: () => api<FraudSettings>(`/orgs/${orgId}/fraud-check/settings`),
    enabled,
  });
}
