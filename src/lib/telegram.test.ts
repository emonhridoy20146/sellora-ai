import { describe, expect, it } from 'vitest';
import { linkCommand, sameTopics, telegramText, wholeNumber } from './telegram';

describe('telegram helpers', () => {
  it('turns the bot’s HTML into plain text', () => {
    expect(telegramText('🔴 <b>Disk &lt;full&gt; &amp; slow</b>\n<i>2 held back</i>')).toBe(
      '🔴 Disk <full> & slow\n2 held back',
    );
  });

  it('compares topic lists in any order', () => {
    expect(sameTopics(['reports', 'backups'], ['backups', 'reports'])).toBe(true);
    expect(sameTopics(['reports'], ['reports', 'ai'])).toBe(false);
  });

  it('keeps thresholds whole and in range', () => {
    expect(wholeNumber('50', 0, 100)).toBe(50);
    expect(wholeNumber('1,200', 0, 1000)).toBe(1000);
    expect(wholeNumber('', 1, 10)).toBe(1);
  });

  it('builds the group link command', () => {
    expect(linkCommand('a1b2c3d4e5f6')).toBe('/link a1b2c3d4e5f6');
  });
});
