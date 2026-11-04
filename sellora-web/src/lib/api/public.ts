import 'server-only';
import type { Plan, PublicPlatformStatus } from './types';

/**
 * Server-side reads of public API data for marketing pages. They return null instead of
 * throwing so the page still renders (without prices) when the API is unreachable.
 */
async function getPublic<T>(path: string, revalidate: number): Promise<T | null> {
  const base = process.env.API_INTERNAL_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/v1${path}`, {
      next: { revalidate },
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function getPublicPlans(): Promise<Plan[] | null> {
  return getPublic<Plan[]>('/public/plans', 300);
}

export function getPlatformStatus(): Promise<PublicPlatformStatus | null> {
  return getPublic<PublicPlatformStatus>('/public/platform-status', 60);
}
