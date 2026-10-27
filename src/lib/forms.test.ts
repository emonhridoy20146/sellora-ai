import { describe, expect, it } from 'vitest';
import { safeNext } from './forms';

describe('safeNext', () => {
  it('keeps relative paths and drops anything that could leave the site', () => {
    expect(safeNext('/app/123/billing', '/app')).toBe('/app/123/billing');
    expect(safeNext('//evil.example', '/app')).toBe('/app');
    expect(safeNext('/\\evil.example', '/app')).toBe('/app');
    expect(safeNext('https://evil.example', '/app')).toBe('/app');
    expect(safeNext(undefined, '/app')).toBe('/app');
    expect(safeNext(['/a', '/b'], '/app')).toBe('/a');
  });
});
