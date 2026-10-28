'use client';

import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Loader2 } from 'lucide-react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import type { LandingSlugCheck } from '@/lib/api/types';
import { slugProblem } from '@/lib/landing';

/**
 * The page's address on its store. Checks it with the API while the person types and shows
 * the full address. Saving checks again, so a race cannot slip through.
 */
export function SlugField({
  orgId,
  storeId,
  value,
  onChange,
  current,
  locked,
  error,
}: {
  orgId: string;
  storeId: string | null;
  value: string;
  onChange: (v: string) => void;
  /** The page's own saved address, which counts as free. */
  current?: string;
  locked?: boolean;
  error?: string;
}) {
  const slug = useDebounced(value.trim().toLowerCase(), 350);
  const local = slug ? slugProblem(slug) : null;
  const check = useQuery({
    queryKey: ['org', orgId, 'landing-pages', 'slug-check', storeId, slug],
    queryFn: ({ signal }) =>
      api<LandingSlugCheck>(`/orgs/${orgId}/landing-pages/slug-check`, {
        query: { storeId: storeId ?? '', slug },
        signal,
      }),
    enabled: !locked && Boolean(storeId) && slug.length > 0 && !local && slug !== current,
    staleTime: 30_000,
  });
  const typing = slug !== value.trim().toLowerCase();
  const result = check.data?.slug === slug ? check.data : undefined;
  const status =
    locked || !value.trim() || slug === current
      ? null
      : local
        ? 'bad'
        : typing || check.isFetching
          ? 'checking'
          : result?.available
            ? 'ok'
            : result
              ? 'bad'
              : null;

  return (
    <Field
      label="Page address"
      htmlFor="lp-slug"
      error={
        error ||
        (status === 'bad' ? (local ?? result?.reason ?? 'This address cannot be used') : undefined)
      }
      hint={
        locked ? (
          'A published page keeps its address, so ads and shared links keep working. Duplicate the page to use another.'
        ) : result?.url ? (
          <span className="break-all">
            Shoppers visit <span className="font-medium text-foreground">{result.url}</span>
          </span>
        ) : (
          'Lower-case letters, numbers and hyphens, after your store’s address.'
        )
      }
    >
      <div className="relative">
        <Input
          id="lp-slug"
          value={value}
          disabled={locked}
          autoComplete="off"
          spellCheck={false}
          maxLength={60}
          aria-invalid={status === 'bad' || Boolean(error)}
          onChange={(e) => onChange(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
          className="pr-9 font-mono"
        />
        <span className="absolute top-1/2 right-3 -translate-y-1/2" aria-live="polite">
          {status === 'checking' && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Checking" />
          )}
          {status === 'ok' && (
            <CircleCheck className="size-4 text-success" aria-label="Available" />
          )}
          {status === 'bad' && (
            <CircleX className="size-4 text-destructive" aria-label="Not available" />
          )}
        </span>
      </div>
    </Field>
  );
}
