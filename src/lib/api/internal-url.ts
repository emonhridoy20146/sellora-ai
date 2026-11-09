/**
 * Where the Next.js server reaches the API: API_INTERNAL_URL without a trailing slash. A bare
 * "host:port" (what Render gives for a service's private address) is read as http.
 */
export function internalApiUrl(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/\/+$/, '');
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}
