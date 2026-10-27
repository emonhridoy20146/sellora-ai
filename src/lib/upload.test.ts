import { describe, expect, it } from 'vitest';
import { fitWithin } from './upload';

describe('fitWithin', () => {
  it('shrinks the longest side to the limit and keeps the shape', () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it('never enlarges a small photo', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it('keeps at least one pixel on very thin images', () => {
    expect(fitWithin(10_000, 2, 1000)).toEqual({ width: 1000, height: 1 });
  });
});
