import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import type { Env } from '../../src/config/env.js';
import { loadEnv } from '../../src/config/env.js';

const keys = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString(
      'base64',
    ),
    pub: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }).toString()).toString(
      'base64',
    ),
  };
})();

/** A complete, isolated configuration for one test file. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  const suffix = randomBytes(4).toString('hex');
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: inject('mongoUri'),
    MONGODB_DB_NAME: `sellora_test_${suffix}`,
    REDIS_URL: inject('redisUrl'),
    REDIS_KEY_PREFIX: `t${suffix}:`,
    JWT_KEY_ID: 'test-key',
    JWT_PRIVATE_KEY: keys.priv,
    JWT_PUBLIC_KEY: keys.pub,
    DATA_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    DATA_ENCRYPTION_ACTIVE_KID: 'k1',
    MAIL_TRANSPORT: 'log',
    WEB_APP_URL: 'http://localhost:3000',
    CORS_ORIGINS: 'http://localhost:3000',
    METRICS_TOKEN: 'test-metrics-token-123456',
    WEBCHAT_TOKEN_SECRET: randomBytes(32).toString('hex'),
    STORAGE_SIGNING_SECRET: randomBytes(32).toString('hex'),
    RATE_LIMIT_IP_MULTIPLIER: '1000',
    ...overrides,
  });
}
