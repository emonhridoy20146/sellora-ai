import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nagadTesting } from './nagad.gateway.js';

describe('Nagad helpers', () => {
  it('reads keys pasted as PEM or as the bare base64 the merchant panel shows', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const bare = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    expect(nagadTesting.pem(pem, 'PUBLIC')).toBe(pem.trim());
    expect(nagadTesting.pem(bare, 'PUBLIC').replace(/\s+/g, '')).toBe(pem.replace(/\s+/g, ''));
  });

  it('stamps requests on Dhaka time (UTC+6), as Nagad expects', () => {
    expect(nagadTesting.dhakaTimestamp(Date.UTC(2026, 10, 10, 20, 5, 9))).toBe('20261111020509');
  });
});
