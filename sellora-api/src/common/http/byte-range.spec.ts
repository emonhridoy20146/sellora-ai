import { describe, expect, it } from 'vitest';
import { parseByteRange } from './byte-range.js';

describe('parseByteRange', () => {
  it('reads the ranges media players ask for', () => {
    expect(parseByteRange('bytes=0-', 9048)).toEqual({ start: 0, end: 9047 });
    expect(parseByteRange('bytes=100-199', 9048)).toEqual({ start: 100, end: 199 });
    expect(parseByteRange('bytes=9000-99999', 9048)).toEqual({ start: 9000, end: 9047 });
    expect(parseByteRange('bytes=-48', 9048)).toEqual({ start: 9000, end: 9047 });
    expect(parseByteRange('bytes=-99999', 9048)).toEqual({ start: 0, end: 9047 });
  });

  it('sends the whole object for no range, other units, several ranges or nonsense', () => {
    for (const h of [
      undefined,
      '',
      'items=0-1',
      'bytes=0-1,5-9',
      'bytes=-',
      'bytes=9-3',
      'bytes=a-b',
    ])
      expect(parseByteRange(h, 9048)).toBeNull();
  });

  it('refuses ranges past the end', () => {
    expect(parseByteRange('bytes=9048-', 9048)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 9048)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});
