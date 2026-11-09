import { describe, expect, it } from 'vitest';
import { internalApiUrl } from './internal-url';

describe('internalApiUrl', () => {
  it('keeps a full URL without its trailing slash', () => {
    expect(internalApiUrl('http://api.railway.internal:4000/')).toBe(
      'http://api.railway.internal:4000',
    );
    expect(internalApiUrl('https://api.example.com')).toBe('https://api.example.com');
  });

  it('reads a bare host:port as http', () => {
    expect(internalApiUrl('sellora-api-x1y2:10000')).toBe('http://sellora-api-x1y2:10000');
  });

  it('is null when not set', () => {
    expect(internalApiUrl(undefined)).toBeNull();
    expect(internalApiUrl('  ')).toBeNull();
  });
});
