import { describe, expect, it } from 'vitest';
import {
  checkDomain,
  dnsRecords,
  judgeDns,
  nextPendingCheck,
  normalizeDomain,
  platformRoots,
  type DnsAnswer,
} from './custom-domains.js';

const ROOTS = platformRoots([
  'shops.sellora.ai',
  'domains.sellora-edge.net',
  'app.sellora.ai',
  'sellora.localhost:3100',
]);

describe('custom domain input', () => {
  it('reduces typed and pasted text to a lower-case ASCII domain', () => {
    expect(normalizeDomain('  WWW.NakshiGhor.com.  ')).toBe('www.nakshighor.com');
    expect(normalizeDomain('https://Shop.Example.com/products?x=1')).toBe('shop.example.com');
    expect(normalizeDomain('shop.example.com/about')).toBe('shop.example.com');
    expect(normalizeDomain('shop.example.com:8080')).toBe('shop.example.com');
    expect(normalizeDomain('দোকান.বাংলা')).toBe('xn--p5b7ah1gxc.xn--54b7fta0cc');
    expect(normalizeDomain('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeDomain('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeDomain('   ')).toBeNull();
  });

  it('lists the registrable domains Sellora itself uses', () => {
    expect(ROOTS).toEqual(['sellora.ai', 'sellora-edge.net', 'sellora.localhost']);
  });

  it('accepts subdomains, and apex domains only when the server has addresses for them', () => {
    expect(checkDomain('www.nakshighor.com', ROOTS, false)).toEqual({
      ok: true,
      parsed: { domain: 'www.nakshighor.com', apex: false },
    });
    expect(checkDomain('shop.nakshighor.com.bd', ROOTS, false)).toMatchObject({
      ok: true,
      parsed: { apex: false },
    });
    expect(checkDomain('nakshighor.com.bd', ROOTS, false)).toEqual({
      ok: false,
      problem: 'apex_unsupported',
    });
    expect(checkDomain('nakshighor.com.bd', ROOTS, true)).toEqual({
      ok: true,
      parsed: { domain: 'nakshighor.com.bd', apex: true },
    });
  });

  it('refuses what a business cannot own or Sellora uses', () => {
    const problem = (d: string) => {
      const r = checkDomain(d, ROOTS, true);
      return r.ok ? null : r.problem;
    };
    expect(problem('com.bd')).toBe('public_suffix');
    expect(problem('github.io')).toBe('public_suffix');
    expect(problem('203.0.113.9')).toBe('ip');
    expect(problem('2001:db8::1')).toBe('ip');
    expect(problem('*.example.com')).toBe('wildcard');
    expect(problem('localhost')).toBe('format');
    expect(problem('shop.localhost')).toBe('format');
    expect(problem('nodots')).toBe('format');
    expect(problem('bad_label.example.com')).toBe('format');
    expect(problem('-start.example.com')).toBe('format');
    expect(problem(`${'a'.repeat(64)}.example.com`)).toBe('format');
    expect(problem('nakshi.shops.sellora.ai')).toBe('platform');
    expect(problem('sellora.ai')).toBe('platform');
    expect(problem('x.sellora-edge.net')).toBe('platform');
    expect(problem('evilsellora.ai')).toBeNull();
  });
});

describe('DNS records for a custom domain', () => {
  const target = 'domains.sellora-edge.net';
  const ips = ['203.0.113.10', '2001:db8::10'];

  it('asks for a TXT record and a CNAME, or A and AAAA records for an apex', () => {
    expect(dnsRecords('www.shop.com', false, 'tok', target, ips)).toEqual([
      expect.objectContaining({
        type: 'TXT',
        name: '_sellora-verify.www.shop.com',
        host: '_sellora-verify.www',
        value: 'sellora-verify=tok',
      }),
      expect.objectContaining({ type: 'CNAME', name: 'www.shop.com', host: 'www', value: target }),
    ]);
    expect(dnsRecords('shop.com.bd', true, 'tok', target, ips).map((r) => r.host)).toEqual([
      '_sellora-verify',
      '@',
      '@',
    ]);
    expect(dnsRecords('shop.com', true, 'tok', target, ips).map((r) => r.type)).toEqual([
      'TXT',
      'A',
      'AAAA',
    ]);
  });

  const answer = (a: Partial<DnsAnswer>): DnsAnswer => ({
    txt: [],
    cname: [],
    addresses: [],
    unreachable: false,
    ...a,
  });
  const sub = { apex: false, token: 'tok', target, ips };
  const apex = { apex: true, token: 'tok', target, ips };

  it('passes a subdomain with the TXT code and a CNAME to the target', () => {
    expect(judgeDns(answer({ txt: ['sellora-verify=tok'], cname: [`${target}.`] }), sub)).toEqual({
      ownership: true,
      routing: true,
      problems: [],
    });
  });

  it('passes a flattened CNAME when every address is the storefront', () => {
    expect(
      judgeDns(answer({ txt: ['other', 'sellora-verify=tok'], addresses: ['203.0.113.10'] }), sub),
    ).toMatchObject({ ownership: true, routing: true });
  });

  it('says what is missing or wrong', () => {
    expect(judgeDns(answer({}), sub).problems).toEqual([
      'The TXT record is not there yet.',
      'The CNAME record is not there yet.',
    ]);
    expect(
      judgeDns(answer({ txt: ['sellora-verify=old'], cname: ['shops.myshopify.com'] }), sub)
        .problems,
    ).toEqual([
      'The TXT record has a different code. Copy the value shown here exactly.',
      `The CNAME record points to shops.myshopify.com, not ${target}.`,
    ]);
    const stray = judgeDns(
      answer({ txt: ['sellora-verify=tok'], addresses: ['203.0.113.10', '198.51.100.7'] }),
      apex,
    );
    expect(stray).toMatchObject({ ownership: true, routing: false });
    expect(stray.problems).toEqual(['The domain also points to 198.51.100.7. Remove that record.']);
    expect(judgeDns(answer({ txt: ['sellora-verify=tok'] }), apex).problems).toEqual([
      'The A record is not there yet.',
    ]);
  });

  it('never calls an apex right through a CNAME, and never judges an unreachable DNS', () => {
    expect(judgeDns(answer({ txt: ['sellora-verify=tok'], cname: [target] }), apex).routing).toBe(
      false,
    );
    expect(
      judgeDns(answer({ txt: ['sellora-verify=tok'], cname: [target], unreachable: true }), sub),
    ).toMatchObject({ ownership: false, routing: false });
  });
});

describe('automatic checks of a pending domain', () => {
  it('backs off, then stops three days after the domain was added', () => {
    const created = new Date('2026-10-28T10:00:00Z');
    const minutes = (checks: number, now: Date) =>
      ((nextPendingCheck(created, checks, now)?.getTime() ?? NaN) - now.getTime()) / 60_000;
    expect(minutes(0, created)).toBe(2);
    expect(minutes(1, created)).toBe(5);
    expect(minutes(4, created)).toBe(60);
    expect(minutes(9, created)).toBe(180);
    expect(nextPendingCheck(created, 30, new Date('2026-10-31T08:00:00Z'))).toBeNull();
  });
});
