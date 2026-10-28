'use client';

import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Loader2 } from 'lucide-react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import type { HandleCheck } from '@/lib/api/types';
import { handleFormatOk } from '@/lib/stores';

/**
 * The store address (its subdomain). Checks the address with the API as the person types
 * and shows the full address it would have. Saving checks again, so a race cannot slip through.
 */
export function HandleField({
  orgId,
  value,
  onChange,
  storeId,
  locked,
  error,
}: {
  orgId: string;
  value: string;
  onChange: (v: string) => void;
  /** The store being edited, so its own address counts as free. */
  storeId?: string;
  locked?: boolean;
  error?: string;
}) {
  const handle = useDebounced(value.trim().toLowerCase(), 350);
  const check = useQuery({
    queryKey: ['org', orgId, 'stores', 'handle-check', handle, storeId ?? ''],
    queryFn: ({ signal }) =>
      api<HandleCheck>(`/orgs/${orgId}/stores/handle-check`, {
        query: { handle, storeId },
        signal,
      }),
    enabled: !locked && handle.length > 0,
    staleTime: 30_000,
  });
  const typing = handle !== value.trim().toLowerCase();
  const result = check.data?.handle === handle ? check.data : undefined;
  const status = locked
    ? null
    : !value.trim()
      ? null
      : typing || check.isFetching
        ? 'checking'
        : result?.available
          ? 'ok'
          : result
            ? 'bad'
            : null;

  return (
    <Field
      label="Store address"
      htmlFor="store-handle"
      error={
        error || (status === 'bad' ? (result?.message ?? 'This address cannot be used') : undefined)
      }
      hint={
        locked ? (
          'The address cannot change once the store has opened.'
        ) : !handleFormatOk(value.trim()) && value.trim() ? (
          '3 to 32 lowercase letters, numbers and single hyphens.'
        ) : result ? (
          <span className="break-all">
            Shoppers visit <span className="font-medium text-foreground">{result.host}</span>
          </span>
        ) : (
          'Lowercase letters, numbers and hyphens. This becomes your store’s web address.'
        )
      }
    >
      <div className="relative">
        <Input
          id="store-handle"
          value={value}
          disabled={locked}
          autoComplete="off"
          spellCheck={false}
          maxLength={32}
          aria-invalid={status === 'bad' || Boolean(error)}
          aria-describedby="store-handle-status"
          onChange={(e) => onChange(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
          className="pr-9"
        />
        <span
          id="store-handle-status"
          className="absolute top-1/2 right-3 -translate-y-1/2"
          aria-live="polite"
        >
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
