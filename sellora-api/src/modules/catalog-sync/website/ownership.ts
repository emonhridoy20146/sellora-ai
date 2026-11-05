import { VERIFY_LABEL, VERIFY_PREFIX } from '../../stores/custom-domains.js';
import type { VerifyRecords } from '../connectors/connector.js';
import type { HtmlPage } from './html-page.js';
import { registrableDomain } from './site-url.js';

/**
 * Proof that a website belongs to the business (ADR 0024): a DNS TXT record
 * `_sellora-verify.<host or registrable domain>` = `sellora-verify=<token>`, or a
 * `<meta name="sellora-site-verification" content="<token>">` tag on the home page.
 */

export const VERIFY_META = 'sellora-site-verification';

export type OwnershipResult =
  | { ok: true; method: 'dns' | 'meta' }
  | {
      ok: false;
      /** Both places were read and neither has the proof (not a site or DNS outage). */
      definite: boolean;
      message: string;
    };

/** The DNS names that may hold the record, most specific first. */
export function verifyNames(host: string): string[] {
  const names = [host.toLowerCase(), registrableDomain(host)];
  return [...new Set(names)];
}

/** What the merchant adds: the TXT record (name, value) and the meta tag. */
export function ownershipInstructions(host: string, token: string) {
  const domain = registrableDomain(host);
  return {
    dnsName: `${VERIFY_LABEL}.${domain}`,
    dnsValue: `${VERIFY_PREFIX}${token}`,
    metaTag: `<meta name="${VERIFY_META}" content="${token}">`,
  };
}

/**
 * Checks the proof. `home` is the parsed home page, or null when it could not be read;
 * `lookup` asks DNS for the TXT records at `_sellora-verify.<name>`.
 */
export async function checkOwnership(input: {
  host: string;
  token: string;
  home: HtmlPage | null;
  lookup?: (domain: string) => Promise<VerifyRecords>;
}): Promise<OwnershipResult> {
  if (input.home?.verification.some((t) => t.trim() === input.token))
    return { ok: true, method: 'meta' };
  let dnsAnswered = Boolean(input.lookup);
  if (input.lookup)
    for (const name of verifyNames(input.host)) {
      const r = await input.lookup(name);
      if (r.unreachable) dnsAnswered = false;
      if (r.txt.some((t) => t.trim() === `${VERIFY_PREFIX}${input.token}`))
        return { ok: true, method: 'dns' };
    }
  const wrongTag = input.home?.verification.length
    ? ' The home page has a sellora-site-verification tag, but with another code.'
    : '';
  if (!input.home)
    return {
      ok: false,
      definite: false,
      message: `The home page could not be read, and DNS has no ${VERIFY_LABEL} record with this code. Try again in a few minutes.${wrongTag}`,
    };
  if (!dnsAnswered)
    return {
      ok: false,
      definite: false,
      message: `The home page has no sellora-site-verification tag with this code, and DNS did not answer. Try again in a few minutes.${wrongTag}`,
    };
  return {
    ok: false,
    definite: true,
    message: `Sellora found neither the sellora-site-verification tag on the home page nor the ${VERIFY_LABEL} TXT record with this code.${wrongTag} DNS changes can take up to an hour to show.`,
  };
}
