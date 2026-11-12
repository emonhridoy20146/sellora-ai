'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { CouponList } from '@/lib/api/types';

export const couponKeys = {
  all: (orgId: string) => ['org', orgId, 'coupons'] as const,
};

export function useCoupons(orgId: string) {
  return useQuery({
    queryKey: couponKeys.all(orgId),
    queryFn: () => api<CouponList>(`/orgs/${orgId}/coupons`),
  });
}
