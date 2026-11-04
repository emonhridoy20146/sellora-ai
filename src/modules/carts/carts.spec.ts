import { describe, expect, it } from 'vitest';
import {
  STEP_GRACE_MS,
  defaultCartSteps,
  enabledSteps,
  inQuietHours,
  itemsSummary,
  nextDue,
  optOutSuffix,
  quietHoursEnd,
} from './cart-templates.js';

const DHAKA = 'Asia/Dhaka';
/** 2026-11-04 at `hour`:`minute` in Dhaka (UTC+6). */
const dhaka = (hour: number, minute = 0, day = 4) =>
  new Date(Date.UTC(2026, 10, day, hour - 6, minute));

describe('cart reminder texts', () => {
  it('sums up the cart shortly, in English and Bangla', () => {
    expect(itemsSummary([{ name: 'Red saree', quantity: 1 }], 'en')).toBe('Red saree');
    expect(itemsSummary([{ name: 'Red saree', quantity: 2 }], 'en')).toBe('2 × Red saree');
    expect(
      itemsSummary(
        [
          { name: 'Red saree', quantity: 1 },
          { name: 'Shawl', quantity: 1 },
          { name: 'Bag', quantity: 3 },
        ],
        'en',
      ),
    ).toBe('Red saree and 2 more');
    expect(
      itemsSummary(
        [
          { name: 'লাল শাড়ি', quantity: 2 },
          { name: 'শাল', quantity: 1 },
        ],
        'bn',
      ),
    ).toBe('২ × লাল শাড়ি ও আরও ১টি পণ্য');
    expect(itemsSummary([{ name: 'A'.repeat(50), quantity: 1 }], 'en')).toBe(`${'A'.repeat(31)}…`);
    expect(itemsSummary([], 'en')).toBe('');
  });

  it('always adds the stop link in the message language', () => {
    expect(optOutSuffix('en', 'https://app.test/u/x')).toBe(' Stop: https://app.test/u/x');
    expect(optOutSuffix('bn', 'https://app.test/u/x')).toBe(' বন্ধ করতে: https://app.test/u/x');
  });

  it('starts with the first reminder on after an hour and the second off', () => {
    const steps = defaultCartSteps('en');
    expect(steps.map((s) => [s.enabled, s.delayMinutes])).toEqual([
      [true, 60],
      [false, 1440],
    ]);
    expect(steps.every((s) => s.text.includes('{link}'))).toBe(true);
    expect(defaultCartSteps('bn')[0]!.text).toContain('কার্টে');
    expect(enabledSteps(steps).map((s) => s.step)).toEqual([1]);
    expect(
      enabledSteps([
        { ...steps[0]!, enabled: false },
        { ...steps[1]!, enabled: true },
      ]),
    ).toEqual([expect.objectContaining({ step: 2, delayMinutes: 1440 })]);
  });
});

describe('quiet hours', () => {
  const night = { enabled: true, startHour: 22, endHour: 9 };

  it('run past midnight in the business’s time zone', () => {
    expect(inQuietHours(dhaka(21, 59), night, DHAKA)).toBe(false);
    expect(inQuietHours(dhaka(22, 0), night, DHAKA)).toBe(true);
    expect(inQuietHours(dhaka(3, 0), night, DHAKA)).toBe(true);
    expect(inQuietHours(dhaka(9, 0), night, DHAKA)).toBe(false);
    expect(inQuietHours(dhaka(3, 0), { ...night, enabled: false }, DHAKA)).toBe(false);
    // The same instant is daytime in another zone.
    expect(inQuietHours(dhaka(3, 0), night, 'Europe/London')).toBe(false);
    const day = { enabled: true, startHour: 13, endHour: 15 };
    expect(inQuietHours(dhaka(14, 0), day, DHAKA)).toBe(true);
    expect(inQuietHours(dhaka(16, 0), day, DHAKA)).toBe(false);
  });

  it('end at the next end hour: the same morning after midnight, the next morning before', () => {
    expect(quietHoursEnd(dhaka(3, 15), night, DHAKA)).toEqual(dhaka(9, 0));
    expect(quietHoursEnd(dhaka(23, 30), night, DHAKA)).toEqual(dhaka(9, 0, 5));
  });
});

describe('when the next reminder is due', () => {
  const steps = enabledSteps([
    { enabled: true, delayMinutes: 60, text: 'a {link}' },
    { enabled: true, delayMinutes: 1440, text: 'b {link}' },
  ]);
  const left = dhaka(12, 0);

  it('counts each step from the shopper’s last change', () => {
    expect(nextDue(left, steps, 0, left)).toEqual({ index: 0, at: dhaka(13, 0) });
    expect(nextDue(left, steps, 1, left)).toEqual({ index: 1, at: dhaka(12, 0, 5) });
    expect(nextDue(left, steps, 2, left)).toBeNull();
  });

  it('skips a step whose time passed long ago instead of sending it late', () => {
    const justInGrace = new Date(dhaka(13, 0).getTime() + STEP_GRACE_MS);
    expect(nextDue(left, steps, 0, justInGrace)).toEqual({ index: 0, at: dhaka(13, 0) });
    const tooLate = new Date(justInGrace.getTime() + 1);
    expect(nextDue(left, steps, 0, tooLate)).toEqual({ index: 1, at: dhaka(12, 0, 5) });
    expect(nextDue(left, steps, 0, dhaka(12, 0, 7))).toBeNull();
  });
});
