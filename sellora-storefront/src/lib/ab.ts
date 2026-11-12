/**
 * The landing page A/B test id (ADR 0031): a random id kept in a first-party cookie so each
 * browser keeps seeing the same version of a page while a test runs. It is not linked to
 * anything else about the shopper and is never sent to another site.
 */
export const AB_COOKIE = 'sl_ab';
/** The header the API reads the id from (set by this app only; a browser's own is dropped). */
export const AB_HEADER = 'x-shopper-ab';
/** Kept for 90 days, longer than any test runs (60 days at most). */
export const AB_MAX_AGE_S = 90 * 86_400;

const AB_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** The id if it has the API's format, else undefined. */
export function validAbId(value: string | null | undefined): string | undefined {
  return value && AB_ID_RE.test(value) ? value : undefined;
}

/** A new random id: 32 hex characters. */
export function newAbId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** The shop's own one-segment pages (the API reserves these words; pages cannot use them). */
const SHOP_PATHS: ReadonlySet<string> = new Set([
  'cart',
  'checkout',
  'order',
  'orders',
  'track',
  'products',
  'product',
  'pages',
  'page',
  'preview',
  'search',
  'thank-you',
]);

/** Whether `/<segment>` may be a landing page (and so gets the A/B id). */
export function mayBeLandingPath(segment: string): boolean {
  return !SHOP_PATHS.has(segment);
}
