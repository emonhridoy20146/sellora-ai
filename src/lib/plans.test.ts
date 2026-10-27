import { describe, expect, it } from 'vitest';
import { limitApplies } from './plans';

describe('limitApplies', () => {
  it('shows a limit only when the plan has its module', () => {
    const inboxOnly = [{ key: 'inbox' }, { key: 'ai_agent' }];
    expect(limitApplies(inboxOnly, 'channels')).toBe(true);
    expect(limitApplies(inboxOnly, 'products')).toBe(false);
    expect(limitApplies(inboxOnly, 'storageMb')).toBe(false);
    expect(limitApplies([{ key: 'commerce' }], 'ordersPerMonth')).toBe(true);
    expect(limitApplies([], 'seats')).toBe(true);
  });
});
