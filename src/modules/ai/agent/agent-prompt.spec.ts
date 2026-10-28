import { describe, expect, it } from 'vitest';
import { buildAgentPrompt, type AgentPromptInput } from './agent-prompt.js';

const base = (over: Partial<AgentPromptInput> = {}): AgentPromptInput => ({
  business: { name: 'Dhaka Fashion', currency: 'BDT', timezone: 'Asia/Dhaka' },
  settings: {
    assistantName: 'Mitu',
    tone: 'friendly',
    language: 'auto',
    businessInfo: 'Cash on delivery all over Bangladesh.',
    instructions: 'Never promise same-day delivery.',
    faqs: [{ question: ' Return? ', answer: ' Within 3 days. ' }],
    takeOrders: true,
  },
  channel: 'website chat',
  catalog: {
    lines: [
      {
        id: 'p1',
        name: 'Jamdani Saree',
        minMinor: 300_000,
        maxMinor: 320_000,
        available: true,
        options: 'Colour: Red, Blue',
        category: 'Sarees',
      },
      { id: 'p2', name: 'Cotton Panjabi', minMinor: 150_000, maxMinor: 150_000, available: false, options: '' },
    ],
    totalActive: 2,
    categories: ['Sarees'],
  },
  zones: [{ id: 'dhaka', name: 'Inside Dhaka', chargeMinor: 6_000 }],
  customer: null,
  // 23:30 UTC is already the next day in Dhaka (UTC+6).
  now: new Date('2026-10-27T23:30:00Z'),
  ...over,
});

describe('agent prompt', () => {
  it('sets out who the agent is, the shop’s knowledge and the catalog', () => {
    const p = buildAgentPrompt(base());
    expect(p).toMatch(/^You are Mitu, the AI sales assistant of Dhaka Fashion, chatting with a customer on website chat\./);
    expect(p).toContain('Reply in the language the customer writes in');
    expect(p).toContain('Warm and friendly');
    expect(p).toContain('Write prices like ৳1,250.');
    expect(p).toContain('## Rules from Dhaka Fashion\nNever promise same-day delivery.');
    expect(p).toContain('## About Dhaka Fashion\nCash on delivery all over Bangladesh.');
    expect(p).toContain('Q: Return?\nA: Within 3 days.');
    expect(p).toContain('- Inside Dhaka (zone id dhaka): ৳60');
    expect(p).toContain('## Catalog (all 2 products)\nCategories: Sarees');
    expect(p).toContain('- Jamdani Saree (id p1): ৳3,000–৳3,200; Colour: Red, Blue; category Sarees');
    expect(p).toContain('- Cotton Panjabi (id p2): ৳1,500, out of stock');
    expect(p).toContain('5. Only after the customer clearly confirms, call create_order.');
    expect(p.endsWith('Today is Wednesday, 28 October 2026.')).toBe(true);
  });

  it('switches the order steps off when the agent may not take orders', () => {
    const p = buildAgentPrompt(base({ settings: { ...base().settings, takeOrders: false } }));
    expect(p).toContain('You cannot place orders yourself.');
    expect(p).not.toContain('create_order');
  });

  it('follows the chosen language, and names the assistant after the shop if unnamed', () => {
    const p = buildAgentPrompt(
      base({ settings: { ...base().settings, language: 'banglish', assistantName: '  ' } }),
    );
    expect(p).toContain('Reply in Banglish');
    expect(p).toMatch(/^You are Dhaka Fashion assistant,/);
  });

  it('says when only the best sellers are listed, and handles an empty shop', () => {
    const partial = buildAgentPrompt(base({ catalog: { ...base().catalog, totalActive: 80 } }));
    expect(partial).toContain('## Catalog (2 of 80 products, best sellers first; use search_products for the rest)');
    const empty = buildAgentPrompt(base({ catalog: { lines: [], totalActive: 0, categories: [] }, zones: [] }));
    expect(empty).toContain('The shop has no products listed yet.');
    expect(empty).toContain('The shop has not set delivery charges');
  });

  it('describes the customer: details, memory and recent orders', () => {
    const p = buildAgentPrompt(
      base({
        customer: {
          name: 'Karima',
          phone: '+8801811111111',
          facts: ['wears size M', 'likes blue'],
          address: 'Mirpur 10, Dhaka',
          orders: [
            {
              number: 'SL-1001',
              status: 'delivered',
              placedAt: new Date('2026-10-01T10:00:00Z'),
              totalMinor: 306_000,
              items: '1× Jamdani Saree (Red)',
            },
          ],
          stats: { orders: 3, delivered: 2, cancelled: 1, returned: 0 },
        },
      }),
    );
    expect(p).toContain(
      [
        '## This customer',
        'Name: Karima',
        'Phone: +8801811111111',
        'Saved address: Mirpur 10, Dhaka',
        'Remembered:',
        '- wears size M',
        '- likes blue',
        'Order history: 3 orders, 2 delivered, 1 cancelled, 0 returned.',
        'Recent orders:',
        '- SL-1001 (delivered, Thursday, 1 October 2026): 1× Jamdani Saree (Red); total ৳3,060',
      ].join('\n'),
    );
    const fresh = buildAgentPrompt(base({ customer: { facts: [], orders: [] } }));
    expect(fresh).toContain('## This customer\nA new customer: nothing is known about them yet.');
  });
});
