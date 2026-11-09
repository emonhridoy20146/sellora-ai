import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

function secrets(): Record<string, string> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
  return {
    JWT_KEY_ID: 'k1',
    JWT_PRIVATE_KEY: b64(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    JWT_PUBLIC_KEY: b64(publicKey.export({ type: 'spki', format: 'pem' })),
    DATA_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    DATA_ENCRYPTION_ACTIVE_KID: 'k1',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
  };
}

describe('loadEnv', () => {
  it('starts from .env.example as it is, with only the generated secrets added', () => {
    const example = parseEnv(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8'));
    const env = loadEnv({ ...example, ...secrets() });
    // Blank optional settings count as not set...
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.META_WEBHOOK_VERIFY_TOKEN).toBeUndefined();
    expect(env.PLATFORM_BOOTSTRAP_EMAIL).toBeUndefined();
    expect(env.PLATFORM_BOOTSTRAP_NAME).toBe('Platform owner');
  });

  it('keeps an empty courier tracking link, which hides the link', () => {
    const env = loadEnv({ ...secrets(), COURIER_PATHAO_TRACKING_URL: '' });
    expect(env.COURIER_PATHAO_TRACKING_URL).toBe('');
    expect(loadEnv(secrets()).COURIER_PATHAO_TRACKING_URL).toContain('pathao');
  });

  it('still refuses a malformed value', () => {
    expect(() => loadEnv({ ...secrets(), TELEGRAM_BOT_TOKEN: 'not-a-token' })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });
});
