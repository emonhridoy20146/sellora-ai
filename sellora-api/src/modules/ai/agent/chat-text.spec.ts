import { describe, expect, it } from 'vitest';
import {
  MAX_CHAT_REPLY,
  chatMoney,
  estimateTokens,
  handoverNotice,
  hasBengaliScript,
  matchKeyword,
  toChatText,
} from './chat-text.js';

describe('chat text', () => {
  it('writes prices the way they read in a chat', () => {
    expect(chatMoney(300_000, 'BDT')).toBe('৳3,000');
    expect(chatMoney(125_050, 'BDT')).toBe('৳1,250.50');
    expect(chatMoney(1_234_567_800, 'BDT')).toBe('৳12,345,678');
    expect(chatMoney(-6_000, 'BDT')).toBe('-৳60');
    expect(chatMoney(1_999, 'USD')).toBe('$19.99');
  });

  it('unwraps Markdown that chat apps would show literally', () => {
    expect(
      toChatText(
        '## Our sarees\n**Jamdani** is ৳3,000 and __Katan__ is *lovely*.\n* Red\n* Blue\n\n\n\nSee [the shop](https://shop.example/s).',
      ),
    ).toBe(
      'Our sarees\nJamdani is ৳3,000 and Katan is lovely.\n- Red\n- Blue\n\nSee the shop (https://shop.example/s).',
    );
    // Arithmetic and lone asterisks are not emphasis.
    expect(toChatText('2 * 3 = 6')).toBe('2 * 3 = 6');
    expect(toChatText('`SL-1001` is your order')).toBe('SL-1001 is your order');
  });

  it('cuts very long replies at a sentence or line break', () => {
    const sentence = 'Ei saree ta khub shundor. ';
    const out = toChatText(sentence.repeat(200));
    expect(out.length).toBeLessThanOrEqual(MAX_CHAT_REPLY);
    expect(out).toMatch(/shundor\.…$/);
  });

  it('matches handover keywords on word boundaries, in any case and in Bengali', () => {
    const keywords = ['talk to a human', 'মানুষ', 'agent'];
    expect(matchKeyword('Can I TALK  to a human please?', keywords)).toBe('talk to a human');
    expect(matchKeyword('আমি মানুষ এর সাথে কথা বলব', keywords)).toBe('মানুষ');
    expect(matchKeyword('আমি মানুষ।', keywords)).toBe('মানুষ');
    expect(matchKeyword('agent?', keywords)).toBe('agent');
    // Part of another word is not a match.
    expect(matchKeyword('the agents list', keywords)).toBeNull();
    expect(matchKeyword('reagent', keywords)).toBeNull();
    expect(matchKeyword('hello', [' ', ''])).toBeNull();
  });

  it('tells the customer about a handover in their script, unless the business wrote its own', () => {
    expect(handoverNotice('', 'দাম কত?')).toBe(
      'ধন্যবাদ! আমাদের টিমের একজন শীঘ্রই আপনাকে উত্তর দেবেন।',
    );
    expect(handoverNotice('', 'dam koto?')).toMatch(/^Thanks for your message!/);
    expect(handoverNotice('  Ekhuni call korchi.  ', 'দাম কত?')).toBe('Ekhuni call korchi.');
    expect(hasBengaliScript('price ৳3,000')).toBe(true); // the taka sign is Bengali script
    expect(hasBengaliScript('dam koto')).toBe(false);
  });

  it('estimates Bengali text as costlier than the same length of English', () => {
    expect(estimateTokens('abcdef')).toBe(2);
    expect(estimateTokens('দাম কত')).toBe(6); // 5 Bengali characters + 1 space (1/3, rounded up)
    expect(estimateTokens('')).toBe(0);
  });
});
