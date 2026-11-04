'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { Category, ShopSettings } from '@/lib/api/types';

export const commerceKeys = {
  all: (orgId: string) => ['org', orgId, 'commerce'] as const,
  products: (orgId: string) => ['org', orgId, 'commerce', 'products'] as const,
  product: (orgId: string, id: string) => ['org', orgId, 'commerce', 'products', id] as const,
  categories: (orgId: string) => ['org', orgId, 'commerce', 'categories'] as const,
  stock: (orgId: string, productId?: string) =>
    ['org', orgId, 'commerce', 'stock', productId ?? 'all'] as const,
  customers: (orgId: string) => ['org', orgId, 'commerce', 'customers'] as const,
  customer: (orgId: string, id: string) => ['org', orgId, 'commerce', 'customers', id] as const,
  orders: (orgId: string) => ['org', orgId, 'commerce', 'orders'] as const,
  summary: (orgId: string) => ['org', orgId, 'commerce', 'orders', 'summary'] as const,
  order: (orgId: string, id: string) => ['org', orgId, 'commerce', 'orders', id] as const,
  settings: (orgId: string) => ['org', orgId, 'commerce', 'settings'] as const,
};

export function useShopSettings(orgId: string, enabled = true) {
  return useQuery({
    queryKey: commerceKeys.settings(orgId),
    queryFn: () => api<ShopSettings>(`/orgs/${orgId}/shop-settings`),
    staleTime: 60_000,
    enabled,
  });
}

export function useCategories(orgId: string, enabled = true) {
  return useQuery({
    queryKey: commerceKeys.categories(orgId),
    queryFn: () => api<Category[]>(`/orgs/${orgId}/categories`),
    enabled,
  });
}
