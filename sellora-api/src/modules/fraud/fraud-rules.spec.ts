import { describe, expect, it } from 'vitest';
import { assessRisk } from './fraud-rules.js';

const own = (
  delivered: number,
  returned: number,
  cancelled = 0,
  orders = delivered + returned + cancelled,
) => ({
  orders,
  delivered,
  returned,
  cancelled,
});

describe('assessRisk', () => {
  it('calls a customer with no finished parcels new', () => {
    expect(assessRisk({ blocked: false, own: own(0, 0) })).toEqual({
      level: 'new',
      successRate: null,
      outcomes: 0,
      reasons: ['No delivery history yet.'],
    });
  });

  it('rates by the delivered share of finished parcels', () => {
    expect(assessRisk({ blocked: false, own: own(9, 1) })).toMatchObject({
      level: 'low',
      successRate: 90,
    });
    expect(assessRisk({ blocked: false, own: own(4, 1) })).toMatchObject({
      level: 'low',
      successRate: 80,
    });
    expect(assessRisk({ blocked: false, own: own(3, 2) })).toMatchObject({
      level: 'medium',
      successRate: 60,
    });
    expect(assessRisk({ blocked: false, own: own(1, 3) })).toMatchObject({
      level: 'high',
      successRate: 25,
    });
  });

  it('does not call one return high risk', () => {
    expect(assessRisk({ blocked: false, own: own(0, 1) })).toMatchObject({
      level: 'medium',
      successRate: 0,
    });
    expect(assessRisk({ blocked: false, own: own(0, 3) })).toMatchObject({ level: 'high' });
  });

  it('adds the Sellora network to the business’s own history', () => {
    const r = assessRisk({
      blocked: false,
      own: own(1, 0),
      network: { businesses: 3, delivered: 1, returned: 4 },
    });
    expect(r).toMatchObject({ level: 'high', successRate: 33, outcomes: 6 });
    expect(r.reasons).toContain('Other shops on Sellora (3): 1 delivered, 4 returned.');
  });

  it('flags frequent cancelling and blocked customers', () => {
    expect(assessRisk({ blocked: false, own: own(0, 0, 3) })).toMatchObject({ level: 'medium' });
    expect(assessRisk({ blocked: false, own: own(5, 0, 3) }).level).toBe('low');
    const blocked = assessRisk({ blocked: true, own: own(5, 0) });
    expect(blocked.level).toBe('high');
    expect(blocked.reasons[0]).toBe('Blocked by your team.');
  });
});
