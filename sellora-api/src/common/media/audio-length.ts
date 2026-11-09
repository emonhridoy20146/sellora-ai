import { parseBuffer } from 'music-metadata';

/** Recordings longer than this are not believed (a broken header can claim hours). */
const MAX_PLAUSIBLE_MS = 6 * 3600_000;

/**
 * How long a recording plays, in whole milliseconds, read from the file itself (Ogg Opus,
 * MP4/M4A, MP3, AAC, AMR, WAV, WebM). Null when the length cannot be read; never throws.
 */
export async function audioLengthMs(bytes: Buffer, contentType?: string): Promise<number | null> {
  try {
    const meta = await parseBuffer(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      contentType ? { mimeType: contentType, size: bytes.length } : { size: bytes.length },
      { duration: true, skipCovers: true, skipPostHeaders: true },
    );
    const seconds = meta.format.duration;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
    const ms = Math.round(seconds * 1000);
    return ms > MAX_PLAUSIBLE_MS ? null : ms;
  } catch {
    return null;
  }
}

/** "0:07", "1:05", "12:30": how a voice note's length is written for people and the AI. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
