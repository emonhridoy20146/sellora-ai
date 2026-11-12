import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/app-config.js';
import { FakeKeywords, KEYWORDS_TEST } from '../../../test/helpers/fake-keywords.js';
import {
  KeywordDataClient,
  KeywordDataError,
  lookupable,
  normalizeKeyword,
} from './keyword-data.js';
import { idTokenEmail, metaContent } from './search-console.client.js';

const config = (env: Record<string, unknown>) =>
  ({ get: (k: string) => env[k] }) as unknown as AppConfig;

const configured = {
  KEYWORDS_DATAFORSEO_LOGIN: KEYWORDS_TEST.login,
  KEYWORDS_DATAFORSEO_PASSWORD: KEYWORDS_TEST.password,
  KEYWORDS_DATAFORSEO_URL: KEYWORDS_TEST.url,
  KEYWORDS_LOCATION_CODE: 2050,
};

describe('Keyword data client (ADR 0032)', () => {
  it('only sends keywords Google Ads accepts', () => {
    expect(lookupable('jamdani saree price')).toBe(true);
    expect(lookupable('জামদানি শাড়ি')).toBe(true);
    expect(lookupable('x'.repeat(81))).toBe(false);
    expect(lookupable('one two three four five six seven eight nine ten eleven')).toBe(false);
    expect(lookupable('50% off')).toBe(false);
    expect(normalizeKeyword('  Jamdani   SAREE ')).toBe('jamdani saree');
  });

  it('reads volumes, competition, cost per click and 12 months, and what was billed', async () => {
    const fake = new FakeKeywords();
    fake.volumes.set('jamdani saree', 1300);
    const client = new KeywordDataClient(config(configured), fake.fetch);
    const r = await client.volumes(['Jamdani Saree', 'jamdani saree', 'nobody searches this']);
    expect(fake.calls).toEqual([
      { keywords: ['jamdani saree', 'nobody searches this'], locationCode: 2050 },
    ]);
    expect(r.costUsdMicros).toBe(75_000);
    expect(r.items[0]).toMatchObject({
      keyword: 'jamdani saree',
      volume: 1300,
      competition: 'high',
      cpcUsdMicros: 50_000,
    });
    expect(r.items[0]!.monthly).toHaveLength(12);
    expect(r.items[0]!.monthly[0]).toMatchObject({ month: 1 });
    expect(r.items[1]).toMatchObject({ volume: null, competition: null, monthly: [] });
  });

  it('tells a refused login, a busy service and a failed task apart', async () => {
    const fake = new FakeKeywords();
    const wrong = new KeywordDataClient(
      config({ ...configured, KEYWORDS_DATAFORSEO_PASSWORD: 'wrong' }),
      fake.fetch,
    );
    await expect(wrong.volumes(['a'])).rejects.toMatchObject({ kind: 'auth' });
    const client = new KeywordDataClient(config(configured), fake.fetch);
    fake.failNext = { status: 429, body: { status_code: 40202, status_message: 'Rate limit' } };
    await expect(client.volumes(['a'])).rejects.toMatchObject({ kind: 'rate_limited' });
    fake.failNext = {
      status: 200,
      body: {
        status_code: 20000,
        tasks: [{ status_code: 40501, status_message: 'Invalid Field' }],
      },
    };
    await expect(client.volumes(['a'])).rejects.toBeInstanceOf(KeywordDataError);
    const none = new KeywordDataClient(config({}), fake.fetch);
    await expect(none.volumes(['a'])).rejects.toMatchObject({ kind: 'not_configured' });
  });

  it('reads the verification code from the tag Google hands out, and the account email', () => {
    expect(metaContent('<meta name="google-site-verification" content="abc123" />')).toBe('abc123');
    expect(metaContent('abc123')).toBe('abc123');
    const jwt = `x.${Buffer.from(JSON.stringify({ email: 'a@b.test' })).toString('base64url')}.y`;
    expect(idTokenEmail(jwt)).toBe('a@b.test');
    expect(idTokenEmail('garbage')).toBe('');
    expect(idTokenEmail(undefined)).toBe('');
  });
});
