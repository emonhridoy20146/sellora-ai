import { randomInt } from 'node:crypto';

const RESERVED = new Set([
  'admin',
  'api',
  'app',
  'www',
  'mail',
  'help',
  'support',
  'status',
  'docs',
  'blog',
  'store',
  'shop',
  'platform',
  'dashboard',
  'login',
  'signup',
  'auth',
  'billing',
  'static',
  'cdn',
  'assets',
  'sellora',
  'root',
  'system',
  'test',
  'dev',
  'staging',
  'beta',
  'ns1',
  'ns2',
  'smtp',
  'ftp',
  'webmail',
  'cpanel',
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED.has(slug);
}

/** Converts a business name (English or Bangla) into a URL-safe slug. */
export function slugify(input: string, maxLength = 40, minLength = 3): string {
  const ascii = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return ascii.length >= minLength ? ascii : `${ascii || 'shop'}-${randomInt(1000, 9999)}`;
}

export function withRandomSuffix(slug: string): string {
  return `${slug.slice(0, 40)}-${randomInt(100, 999)}`;
}
