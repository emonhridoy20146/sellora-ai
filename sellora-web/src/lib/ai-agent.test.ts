import { describe, expect, it } from 'vitest';
import type { AiAgentSettings } from '@/lib/api/types';
import {
  addKeywords,
  changedFields,
  previewDraft,
  repliesLeft,
  toDraft,
  validateDraft,
} from './ai-agent';

const saved: AiAgentSettings = {
  enabled: false,
  assistantName: '',
  tone: 'friendly',
  language: 'auto',
  tier: 'fast',
  businessInfo: 'Cash on delivery.',
  instructions: '',
  faqs: [{ question: 'Return?', answer: 'Within 3 days.' }],
  takeOrders: true,
  confirmOrders: false,
  handoverKeywords: ['talk to a human'],
  handoverMessage: '',
  replyDelaySeconds: 3,
  maxRepliesPerDay: 40,
  updatedAt: '2026-10-28T00:00:00.000Z',
};

const all = { behaviour: true, knowledge: true };

describe('AI agent settings form', () => {
  it('sends only what changed', () => {
    const d = toDraft(saved);
    expect(changedFields(saved, d, all)).toEqual({});
    d.tone = 'professional';
    d.replyDelaySeconds = ' 5 ';
    d.businessInfo = '  Cash on delivery all over Bangladesh. ';
    expect(changedFields(saved, d, all)).toEqual({
      tone: 'professional',
      replyDelaySeconds: 5,
      businessInfo: 'Cash on delivery all over Bangladesh.',
    });
  });

  it('leaves out fields the member may not change', () => {
    const d = toDraft(saved);
    d.enabled = true;
    d.faqs.push({ question: 'Delivery time?', answer: '2-4 days.' });
    expect(changedFields(saved, d, { behaviour: false, knowledge: true })).toEqual({
      faqs: [...saved.faqs, { question: 'Delivery time?', answer: '2-4 days.' }],
    });
    expect(changedFields(saved, d, { behaviour: true, knowledge: false })).toEqual({
      enabled: true,
    });
  });

  it('checks limits and numbers before saving', () => {
    const d = toDraft(saved);
    d.replyDelaySeconds = '31';
    d.maxRepliesPerDay = '0';
    d.faqs.push({ question: '  ', answer: 'x'.repeat(1_001) });
    d.assistantName = 'n'.repeat(61);
    expect(validateDraft(d)).toEqual({
      replyDelaySeconds: 'A whole number from 0 to 30.',
      maxRepliesPerDay: 'A whole number from 1 to 500.',
      'faq-1-q': 'Write the question',
      'faq-1-a': 'Up to 1000 characters.',
      assistantName: 'Up to 60 characters.',
    });
    expect(validateDraft(toDraft(saved))).toEqual({});
    expect(
      validateDraft({ ...toDraft(saved), replyDelaySeconds: '1.5' }).replyDelaySeconds,
    ).toBeTruthy();
  });

  it('adds handover phrases once, tidied the way the API stores them', () => {
    expect(addKeywords(['talk to a human'], ' Talk to a  HUMAN, refund\nমানুষ ,, ')).toEqual([
      'talk to a human',
      'refund',
      'মানুষ',
    ]);
    expect(addKeywords([], 'x'.repeat(61))).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `k${i}`);
    expect(addKeywords(many, 'one more')).toHaveLength(30);
  });

  it('tries unsaved settings in the test chat, skipping half-written questions', () => {
    const d = toDraft(saved);
    d.faqs.push({ question: 'Exchange?', answer: '' });
    d.language = 'banglish';
    expect(previewDraft(d)).toEqual({
      assistantName: '',
      tone: 'friendly',
      language: 'banglish',
      tier: 'fast',
      businessInfo: 'Cash on delivery.',
      instructions: '',
      faqs: [{ question: 'Return?', answer: 'Within 3 days.' }],
      takeOrders: true,
    });
  });

  it('counts the replies the wallet pays for', () => {
    expect(repliesLeft(25_000, 160)).toBe(156);
    expect(repliesLeft(100, 160)).toBe(0);
    expect(repliesLeft(-50, 160)).toBe(0);
    expect(repliesLeft(25_000, undefined)).toBeNull();
  });
});
