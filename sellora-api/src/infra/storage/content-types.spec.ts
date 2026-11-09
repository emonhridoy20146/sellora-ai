import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentTypeForKey, sniffAudioType, sniffImageType, SNIFF_BYTES } from './content-types.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../test/fixtures/audio/${name}`, import.meta.url)).subarray(
    0,
    SNIFF_BYTES,
  );
const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
  );

describe('sniffAudioType', () => {
  it('recognises the recordings phones and Meta send, from their bytes', () => {
    expect(sniffAudioType(fixture('voice-4s.ogg'))).toBe('audio/ogg');
    expect(sniffAudioType(fixture('voice-2s.m4a'))).toBe('audio/mp4');
    expect(sniffAudioType(fixture('voice-1s.mp3'))).toBe('audio/mpeg');
    expect(sniffAudioType(bytes('#!AMR\n', [0x3c, 0x91]))).toBe('audio/amr');
    expect(sniffAudioType(bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt '))).toBe('audio/wav');
    expect(sniffAudioType(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f]))).toBe('audio/webm');
    // An MP3 frame without a tag, and an AAC (ADTS) frame.
    expect(sniffAudioType(bytes([0xff, 0xfb, 0x90, 0x64]))).toBe('audio/mpeg');
    expect(sniffAudioType(bytes([0xff, 0xf1, 0x50, 0x80]))).toBe('audio/aac');
  });

  it('does not take photos or other files for recordings', () => {
    expect(sniffAudioType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBeNull(); // JPEG
    expect(sniffAudioType(bytes([0, 0, 0, 0x1c], 'ftypavif'))).toBeNull(); // AVIF
    expect(sniffAudioType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBeNull(); // WebP
    expect(sniffAudioType(bytes('%PDF-1.7'))).toBeNull();
    expect(sniffAudioType(Buffer.alloc(0))).toBeNull();
  });

  it('leaves photo sniffing as it was', () => {
    expect(sniffImageType(fixture('voice-4s.ogg'))).toBeNull();
    expect(sniffImageType(bytes([0, 0, 0, 0x1c], 'ftypavif'))).toBe('image/avif');
  });

  it('maps stored keys back to their type', () => {
    expect(contentTypeForKey('o/abc/chat/def.ogg')).toBe('audio/ogg');
    expect(contentTypeForKey('o/abc/chat/def.m4a')).toBe('audio/mp4');
    expect(contentTypeForKey('o/abc/chat/def.jpg')).toBe('image/jpeg');
    expect(contentTypeForKey('o/abc/chat/def.exe')).toBe('application/octet-stream');
  });
});
