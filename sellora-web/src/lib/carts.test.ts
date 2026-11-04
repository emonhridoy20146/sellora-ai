import { describe, expect, it } from 'vitest';
import {
  CART_VIEWS,
  SKIP_LABEL,
  canRemindNow,
  cartBadge,
  cartItemsLine,
  composeReminder,
  delayLabel,
  hourLabel,
  isCartView,
  reminderLabel,
  reminderProblem,
  sentCount,
  stepOrderProblem,
} from './carts';
import type { CartReminderEntry } from './api/types';

const samples = {
  name: 'Rahim',
  shop: 'Nakshi Ghor',
  items: 'Red saree and 1 more',
  total: 'Tk 2,500',
  link: 'https://your-shop.shops.test/r/Ab12Cd34Ef',
};
const stop = ' Stop: http://localhost:3000/u/Ab12Cd34';
const opts = (composed: string) => ({
  placeholders: Object.keys(samples),
  maxChars: 480,
  maxParts: 3,
  composed,
});

const sent: CartReminderEntry = {
  step: 1,
  manual: false,
  at: '2026-11-04T10:00:00.000Z',
  skipped: null,
  message: { id: 'm1', status: 'sent', priceMinor: 35, currency: 'BDT', error: null },
};
const refused: CartReminderEntry = { ...sent, skipped: 'off', message: null };

describe('cart reminder wording (same as the API sends)', () => {
  it('fills values and adds the stop link', () => {
    expect(
      composeReminder(
        'Hi {name}, you left {items} at {shop}. Order here: {link}',
        samples,
        'en',
        stop,
      ),
    ).toBe(
      'Hi Rahim, you left Red saree and 1 more at Nakshi Ghor. Order here: https://your-shop.shops.test/r/Ab12Cd34Ef Stop: http://localhost:3000/u/Ab12Cd34',
    );
  });

  it('drops the comma an empty name leaves and capitalises English', () => {
    const out = composeReminder(
      '{name}, your {shop} cart is saved: {link}',
      { ...samples, name: '' },
      'en',
      stop,
    );
    expect(out.startsWith('Your Nakshi Ghor cart is saved:')).toBe(true);
    // Bangla has no capitals; only the punctuation goes.
    expect(composeReminder('{name}, কার্ট: {link}', { ...samples, name: '' }, 'bn', ' বন্ধ')).toBe(
      'কার্ট: https://your-shop.shops.test/r/Ab12Cd34Ef বন্ধ',
    );
  });

  it('asks for the link, known placeholders, and a length that fits', () => {
    const ok = 'Your cart: {link}';
    expect(
      reminderProblem({ enabled: true, text: ok }, opts(composeReminder(ok, samples, 'en', stop))),
    ).toBeNull();
    expect(reminderProblem({ enabled: true, text: '' }, opts(''))).toBe(
      'Write the message or turn it off',
    );
    // A step that is off may stay empty, or keep text without the link.
    expect(reminderProblem({ enabled: false, text: '' }, opts(''))).toBeNull();
    expect(reminderProblem({ enabled: false, text: 'Come back' }, opts('Come back'))).toBeNull();
    expect(reminderProblem({ enabled: true, text: 'Come back' }, opts('Come back'))).toMatch(
      /Put \{link\}/,
    );
    expect(reminderProblem({ enabled: true, text: '{link} {code}' }, opts('x'))).toBe(
      'This message cannot use {code}',
    );
    expect(reminderProblem({ enabled: true, text: '{link}' }, opts('a'.repeat(500)))).toMatch(
      /about 4 SMS parts; the most is 3/,
    );
    expect(reminderProblem({ enabled: true, text: `${'a'.repeat(481)}{link}` }, opts('x'))).toBe(
      'At most 480 characters',
    );
  });

  it('wants the second reminder after the first, only when both are on', () => {
    expect(
      stepOrderProblem([
        { enabled: true, delayMinutes: 60 },
        { enabled: true, delayMinutes: 60 },
      ]),
    ).toMatch(/after the first/);
    expect(
      stepOrderProblem([
        { enabled: true, delayMinutes: 60 },
        { enabled: true, delayMinutes: 1440 },
      ]),
    ).toBeNull();
    expect(
      stepOrderProblem([
        { enabled: true, delayMinutes: 720 },
        { enabled: false, delayMinutes: 60 },
      ]),
    ).toBeNull();
  });
});

describe('cart labels', () => {
  it('names delays and hours the way people say them', () => {
    expect([30, 60, 120, 360, 720, 1440, 2880].map(delayLabel)).toEqual([
      '30 minutes',
      '1 hour',
      '2 hours',
      '6 hours',
      '12 hours',
      '1 day',
      '2 days',
    ]);
    expect([0, 9, 12, 13, 22, 23].map(hourLabel)).toEqual([
      '12 AM',
      '9 AM',
      '12 PM',
      '1 PM',
      '10 PM',
      '11 PM',
    ]);
  });

  it('badges a cart by what happened to it', () => {
    expect(cartBadge({ state: 'shopping', recovered: false, reminders: [] }).label).toBe(
      'Still shopping',
    );
    expect(cartBadge({ state: 'open', recovered: false, reminders: [] })).toEqual({
      label: 'Left',
      tone: 'warning',
    });
    // A refused reminder (SMS off) is not a reminder the shopper got.
    expect(cartBadge({ state: 'open', recovered: false, reminders: [refused] }).label).toBe('Left');
    expect(cartBadge({ state: 'open', recovered: false, reminders: [sent] }).label).toBe(
      'Reminded',
    );
    expect(cartBadge({ state: 'ordered', recovered: true, reminders: [sent] })).toEqual({
      label: 'Recovered',
      tone: 'success',
    });
    expect(cartBadge({ state: 'ordered', recovered: false, reminders: [] }).label).toBe('Ordered');
    expect(cartBadge({ state: 'dismissed', recovered: false, reminders: [] }).label).toBe(
      'Stopped',
    );
    expect(sentCount([sent, refused, sent])).toBe(2);
  });

  it('sums up the cart and the reminders', () => {
    const line = {
      productId: 'p',
      variantId: 'v',
      name: 'Red saree',
      variantTitle: '',
      unitPriceMinor: 100,
    };
    expect(cartItemsLine([])).toBe('Empty cart');
    expect(cartItemsLine([{ ...line, quantity: 1 }])).toBe('Red saree');
    expect(
      cartItemsLine([
        { ...line, quantity: 2 },
        { ...line, quantity: 1 },
        { ...line, quantity: 1 },
      ]),
    ).toBe('2 × Red saree and 2 more');
    expect(reminderLabel({ step: 2, manual: false })).toBe('Reminder 2');
    expect(reminderLabel({ step: 0, manual: true })).toBe('Sent by hand');
    expect(canRemindNow({ status: 'open', manualRemindersLeft: 1 })).toBe(true);
    expect(canRemindNow({ status: 'open', manualRemindersLeft: 0 })).toBe(false);
    expect(canRemindNow({ status: 'ordered', manualRemindersLeft: 3 })).toBe(false);
  });

  it('knows every view and skip reason', () => {
    expect(CART_VIEWS.map((v) => v.value)).toEqual([
      'abandoned',
      'recovered',
      'ordered',
      'dismissed',
      'all',
    ]);
    expect(isCartView('recovered')).toBe(true);
    expect(isCartView('open')).toBe(false);
    expect(isCartView(null)).toBe(false);
    expect(Object.keys(SKIP_LABEL)).toHaveLength(7);
  });
});
