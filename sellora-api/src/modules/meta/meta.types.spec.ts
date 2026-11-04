import { describe, expect, it } from 'vitest';
import { replyWindowEndsAt, replyWindowOpen } from '../inbox/reply-window.js';
import { MAX_TEXT, splitText } from './meta.types.js';

describe('splitText', () => {
  it('keeps short text whole', () => {
    expect(splitText('  Ji ache  ', 1000)).toEqual(['Ji ache']);
    expect(splitText('   ', 1000)).toEqual([]);
  });

  it('prefers paragraph, then line, then sentence, then word breaks', () => {
    const para = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`;
    expect(splitText(para, 100)).toEqual(['a'.repeat(60), 'b'.repeat(60)]);
    const sentences = `${'Amader kache ache. '.repeat(8)}`;
    const parts = splitText(sentences, 60);
    expect(parts.every((p) => p.length <= 60)).toBe(true);
    expect(parts.every((p) => p.endsWith('.'))).toBe(true);
    expect(parts.join(' ')).toBe(sentences.trim());
  });

  it('cuts by characters, never inside an emoji, when there is no break', () => {
    const text = '😀'.repeat(15);
    const parts = splitText(text, 10);
    expect(parts.map((p) => Array.from(p).length)).toEqual([10, 5]);
    expect(parts.join('')).toBe(text);
  });

  it('fits Instagram’s 1000 characters with Bangla text', () => {
    const bangla = 'আমাদের কাছে লাল জামদানি শাড়ি আছে। '.repeat(60);
    const parts = splitText(bangla, MAX_TEXT.instagram);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => Array.from(p).length <= MAX_TEXT.instagram)).toBe(true);
    expect(parts.every((p) => p.endsWith('।'))).toBe(true);
  });
});

describe('reply window', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

  it('allows replies for 24 hours after the customer’s last message on Meta channels', () => {
    expect(replyWindowOpen('messenger', hoursAgo(23.9), now)).toBe(true);
    expect(replyWindowOpen('whatsapp', hoursAgo(24.1), now)).toBe(false);
    expect(replyWindowOpen('instagram', undefined, now)).toBe(false);
    expect(replyWindowEndsAt('messenger', hoursAgo(1))?.toISOString()).toBe(
      '2026-10-29T11:00:00.000Z',
    );
  });

  it('has no window on the website chat', () => {
    expect(replyWindowOpen('web_chat', hoursAgo(400), now)).toBe(true);
    expect(replyWindowEndsAt('web_chat', hoursAgo(1))).toBeNull();
  });
});
