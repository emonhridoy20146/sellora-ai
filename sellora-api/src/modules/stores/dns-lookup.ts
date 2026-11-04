import { Resolver } from 'node:dns/promises';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { VERIFY_LABEL, type DnsAnswer } from './custom-domains.js';

/** Looks up what DNS says about a custom domain. Tests replace it with a fake. */
export interface DnsLookup {
  lookup(domain: string): Promise<DnsAnswer>;
}

export const DNS_LOOKUP = Symbol('DNS_LOOKUP');

/** "No such name" and "no records of this type" are answers; anything else is a failure. */
const EMPTY_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'ENONAME']);

/**
 * DNS through Node's resolver, asking DNS_SERVERS when set (public resolvers in production,
 * so a record added a minute ago is not hidden by this server's cache).
 */
@Injectable()
export class NodeDnsLookup implements DnsLookup {
  private readonly servers: string[];

  constructor(config: AppConfig) {
    this.servers = config.get('DNS_SERVERS');
  }

  private resolver(): Resolver {
    const r = new Resolver({ timeout: 3000, tries: 2 });
    if (this.servers.length) r.setServers(this.servers);
    return r;
  }

  async lookup(domain: string): Promise<DnsAnswer> {
    const r = this.resolver();
    let unreachable = false;
    const ask = async <T>(fn: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await fn();
      } catch (err) {
        if (!EMPTY_CODES.has((err as NodeJS.ErrnoException).code ?? '')) unreachable = true;
        return [];
      }
    };
    const [txt, cname, v4, v6] = await Promise.all([
      ask(() => r.resolveTxt(`${VERIFY_LABEL}.${domain}`)),
      ask(() => r.resolveCname(domain)),
      ask(() => r.resolve4(domain)),
      ask(() => r.resolve6(domain)),
    ]);
    return {
      txt: txt.map((chunks) => chunks.join('')),
      cname,
      addresses: [...v4, ...v6],
      unreachable,
    };
  }
}
