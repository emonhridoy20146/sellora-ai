import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { audioLengthMs, formatClock } from './audio-length.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../test/fixtures/audio/${name}`, import.meta.url));

describe('audioLengthMs', () => {
  it('reads the length of Ogg Opus, MP4 and MP3 recordings from the file', async () => {
    expect(await audioLengthMs(fixture('voice-4s.ogg'), 'audio/ogg')).toBe(4_200);
    const m4a = await audioLengthMs(fixture('voice-2s.m4a'), 'audio/mp4');
    expect(m4a).toBeGreaterThan(2_400);
    expect(m4a).toBeLessThan(2_600);
    const mp3 = await audioLengthMs(fixture('voice-1s.mp3'));
    expect(mp3).toBeGreaterThan(1_400);
    expect(mp3).toBeLessThan(1_700);
  });

  it('answers null for bytes that are not a readable recording', async () => {
    expect(await audioLengthMs(Buffer.from('not audio at all'), 'audio/ogg')).toBeNull();
    expect(await audioLengthMs(fixture('voice-4s.ogg').subarray(0, 40), 'audio/ogg')).toBeNull();
    expect(await audioLengthMs(Buffer.alloc(0))).toBeNull();
  });
});

describe('formatClock', () => {
  it('writes lengths the way phones show them', () => {
    expect(formatClock(4_200)).toBe('0:04');
    expect(formatClock(4_600)).toBe('0:05');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(750_000)).toBe('12:30');
    expect(formatClock(-5)).toBe('0:00');
  });
});
