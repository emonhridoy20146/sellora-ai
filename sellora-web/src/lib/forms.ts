import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from './api/errors';

/**
 * Puts the API's field errors next to the matching inputs. Returns true when at least one
 * error was placed, so the caller can skip a generic message.
 */
export function applyServerErrors<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  fields: readonly string[],
  rename: (apiPath: string) => string = (k) => k,
): boolean {
  if (!(err instanceof ApiError)) return false;
  let placed = false;
  for (const [apiKey, message] of Object.entries(err.fieldErrors())) {
    const key = rename(apiKey);
    if (fields.includes(key)) {
      setError(key as Path<T>, { type: 'server', message });
      placed = true;
    }
  }
  return placed;
}

/** Only same-site relative paths are allowed as a post-login destination. */
export function safeNext(next: string | string[] | undefined, fallback: string): string {
  const v = Array.isArray(next) ? next[0] : next;
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return fallback;
  return v;
}
