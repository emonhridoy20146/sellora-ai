import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { parse as parseDomain } from 'tldts';

/**
 * Custom domains for stores (ADR 0015): what a business may connect, the DNS records that
 * prove it, and reading what DNS answered. Pure functions; the lookups live in DnsLookup.
 */

/** Ownership records live at this label under the domain. */
export const VERIFY_LABEL = '_sellora-verify';
export const VERIFY_PREFIX = 'sellora-verify=';
/** Domains one store may have. */
export const MAX_DOMAINS_PER_STORE = 3;

export type DomainProblem =
  'format' | 'ip' | 'public_suffix' | 'platform' | 'apex_unsupported' | 'wildcard';

export const DOMAIN_MESSAGES: Record<DomainProblem, string> = {
  format: 'Enter a domain such as www.yourshop.com',
  ip: 'Enter a domain name, not an IP address',
  public_suffix: 'This is not a domain you can own; enter your full domain, e.g. yourshop.com.bd',
  platform: 'This is a Sellora address; enter a domain you own',
  apex_unsupported:
    'Use a subdomain such as www.yourshop.com (this server cannot point a bare domain at stores)',
  wildcard: 'Enter one domain, without *',
};

export interface ParsedDomain {
  /** Lower-case ASCII (punycode for international names). */
  domain: string;
  /** The registrable domain itself (example.com), not a subdomain (www.example.com). */
  apex: boolean;
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Reduces what a person typed or pasted ("https://Shop.Example.com/", "ঢাকা.বাংলা") to a
 * domain. Returns null when there is nothing domain-like in it.
 */
export function normalizeDomain(input: string): string | null {
  let raw = input.trim().toLowerCase();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) {
    try {
      raw = new URL(raw).hostname;
    } catch {
      return null;
    }
  } else {
    raw = raw.replace(/[/?#].*$/, '');
  }
  raw = raw.replace(/\.$/, '');
  if (raw.startsWith('[') || isIP(raw) !== 0) return raw;
  if (!raw.startsWith('*.')) raw = raw.replace(/:\d+$/, '');
  const ascii = raw.startsWith('*.') ? raw : domainToASCII(raw);
  return ascii || null;
}

/** Hosts under which no business may add a domain (Sellora's own names). */
export function platformRoots(hosts: (string | undefined)[]): string[] {
  const roots = new Set<string>();
  for (const h of hosts) {
    if (!h) continue;
    const host = h.toLowerCase().replace(/:\d+$/, '');
    const registrable = parseDomain(host, { allowPrivateDomains: true }).domain;
    roots.add(registrable ?? host);
  }
  return [...roots];
}

/**
 * Checks a normalised domain. `roots` are Sellora's own registrable domains; `apexAllowed`
 * says whether the server has addresses for bare domains.
 */
export function checkDomain(
  domain: string,
  roots: string[],
  apexAllowed: boolean,
): { ok: true; parsed: ParsedDomain } | { ok: false; problem: DomainProblem } {
  if (domain.includes('*')) return { ok: false, problem: 'wildcard' };
  if (isIP(domain.replace(/^\[|\]$/g, '')) !== 0) return { ok: false, problem: 'ip' };
  const labels = domain.split('.');
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    !labels.every((l) => LABEL_RE.test(l)) ||
    domain === 'localhost' ||
    domain.endsWith('.localhost')
  )
    return { ok: false, problem: 'format' };
  const info = parseDomain(domain, { allowPrivateDomains: true });
  if (!info.domain || !info.publicSuffix || info.isIp)
    return { ok: false, problem: 'public_suffix' };
  if (roots.some((r) => domain === r || domain.endsWith(`.${r}`)))
    return { ok: false, problem: 'platform' };
  const apex = info.domain === domain;
  if (apex && !apexAllowed) return { ok: false, problem: 'apex_unsupported' };
  return { ok: true, parsed: { domain, apex } };
}

/** A record to add, with its name in full and as most DNS providers ask for it. */
export interface DnsRecordSpec {
  type: 'TXT' | 'CNAME' | 'A' | 'AAAA';
  /** The full name. */
  name: string;
  /** The name relative to the registrable domain ("www", "@" for the domain itself). */
  host: string;
  value: string;
  purpose: string;
}

/** The part of `name` before its registrable domain, as DNS providers' "Host" fields want. */
export function relativeHost(name: string): string {
  const zone = parseDomain(name, { allowPrivateDomains: true }).domain;
  if (!zone || name === zone) return '@';
  return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
}

/** The records a business adds at its DNS provider, as the dashboard shows them. */
export function dnsRecords(
  domain: string,
  apex: boolean,
  token: string,
  target: string,
  ips: string[],
): DnsRecordSpec[] {
  const record = (type: DnsRecordSpec['type'], name: string, value: string, purpose: string) => ({
    type,
    name,
    host: relativeHost(name),
    value,
    purpose,
  });
  const verify = `${VERIFY_LABEL}.${domain}`;
  const records = [record('TXT', verify, `${VERIFY_PREFIX}${token}`, 'Proves the domain is yours')];
  if (apex)
    for (const ip of ips)
      records.push(
        record(isIP(ip) === 6 ? 'AAAA' : 'A', domain, ip, 'Sends visitors to your store'),
      );
  else records.push(record('CNAME', domain, target, 'Sends visitors to your store'));
  return records;
}

/** What DNS answered for a domain. Empty lists mean "no such records". */
export interface DnsAnswer {
  txt: string[];
  cname: string[];
  addresses: string[];
  /** A DNS server could not be reached or failed, so the answer says nothing either way. */
  unreachable: boolean;
}

export interface DnsVerdict {
  ownership: boolean;
  routing: boolean;
  /** Plain reasons for what is still wrong, for the dashboard. */
  problems: string[];
}

const clean = (h: string) => h.toLowerCase().replace(/\.$/, '');

/** Reads a DNS answer against the records the business was asked to add. */
export function judgeDns(
  answer: DnsAnswer,
  opts: { apex: boolean; token: string; target: string; ips: string[] },
): DnsVerdict {
  const problems: string[] = [];
  if (answer.unreachable)
    return {
      ownership: false,
      routing: false,
      problems: ['Your domain’s DNS servers did not answer. We will try again.'],
    };
  const ownership = answer.txt.some((t) => t.trim() === `${VERIFY_PREFIX}${opts.token}`);
  if (!ownership)
    problems.push(
      answer.txt.some((t) => t.trim().startsWith(VERIFY_PREFIX))
        ? 'The TXT record has a different code. Copy the value shown here exactly.'
        : 'The TXT record is not there yet.',
    );
  const ours = new Set(opts.ips.map((ip) => ip.toLowerCase()));
  const cnameOk = answer.cname.some((c) => clean(c) === clean(opts.target));
  const addressesOk =
    answer.addresses.length > 0 && answer.addresses.every((a) => ours.has(a.toLowerCase()));
  const routing = (!opts.apex && cnameOk) || (ours.size > 0 && addressesOk);
  if (!routing) {
    if (answer.cname.length && !cnameOk)
      problems.push(`The CNAME record points to ${clean(answer.cname[0]!)}, not ${opts.target}.`);
    else if (answer.addresses.length && !addressesOk) {
      const stray = answer.addresses.filter((a) => !ours.has(a.toLowerCase()));
      problems.push(
        `The domain also points to ${stray.join(', ')}. Remove ${stray.length === 1 ? 'that record' : 'those records'}.`,
      );
    } else
      problems.push(
        opts.apex ? 'The A record is not there yet.' : 'The CNAME record is not there yet.',
      );
  }
  return { ownership, routing, problems };
}

/** Minutes until the next automatic check of a pending domain, by checks made so far. */
const PENDING_BACKOFF_MIN = [2, 5, 10, 30, 60];
const PENDING_STEADY_MIN = 180;
/** Pending domains are checked automatically for this long after they are added. */
export const PENDING_WINDOW_MS = 3 * 86_400_000;
export const ACTIVE_RECHECK_MS = 86_400_000;

/** When a pending domain should be checked next, or null when automatic checks stop. */
export function nextPendingCheck(createdAt: Date, checks: number, now: Date): Date | null {
  const minutes = PENDING_BACKOFF_MIN[checks] ?? PENDING_STEADY_MIN;
  const next = new Date(now.getTime() + minutes * 60_000);
  return next.getTime() - createdAt.getTime() > PENDING_WINDOW_MS ? null : next;
}
