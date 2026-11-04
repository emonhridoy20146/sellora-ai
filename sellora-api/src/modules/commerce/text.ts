/** Escapes user input for use inside a regular expression. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * URL-safe slug. Keeps Bengali and other letters (browsers handle them in paths), drops
 * punctuation, and collapses spaces to dashes.
 */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'item';
}

/** Lower-cased words used by the simple contains-search on products and customers. */
export function searchText(...parts: (string | undefined | null | string[])[]): string {
  return parts
    .flat()
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
}
