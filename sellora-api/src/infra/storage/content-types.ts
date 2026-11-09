/**
 * File types the platform accepts, with the bytes each one starts with. SVG is left out on
 * purpose: it can carry scripts.
 */
export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
} as const;

export type ImageType = keyof typeof IMAGE_TYPES;

/**
 * Voice notes customers send in chats (ADR 0025): WhatsApp records Ogg Opus, Messenger and
 * Instagram send MP4 audio; the rest are what phones and browsers commonly produce.
 */
export const AUDIO_TYPES = {
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
} as const;

export type AudioType = keyof typeof AUDIO_TYPES;

/** Every stored type and its file extension. */
export const MEDIA_TYPES = { ...IMAGE_TYPES, ...AUDIO_TYPES } as const;
export type MediaType = keyof typeof MEDIA_TYPES;

const EXT_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(MEDIA_TYPES).map(([type, ext]) => [ext, type]),
);

/** Extensions a stored file's key may end with. */
export const MEDIA_EXTENSIONS: readonly string[] = Object.values(MEDIA_TYPES);

export function contentTypeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return EXT_TO_TYPE[ext] ?? 'application/octet-stream';
}

/** How many leading bytes `sniffImageType` and `sniffAudioType` need. */
export const SNIFF_BYTES = 32;

const ascii = (head: Buffer, start: number, end: number) =>
  head.subarray(start, end).toString('latin1');

/** The image type the bytes really are, or null when they are not a supported image. */
export function sniffImageType(head: Buffer): ImageType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return 'image/jpeg';
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (head.length >= 6 && (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a'))
    return 'image/gif';
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP')
    return 'image/webp';
  if (
    head.length >= 12 &&
    ascii(head, 4, 8) === 'ftyp' &&
    ['avif', 'avis'].includes(ascii(head, 8, 12))
  )
    return 'image/avif';
  return null;
}

/**
 * The audio type the bytes really are, or null. MP4 and WebM containers can also hold
 * video; they are accepted only where audio is expected, and played as audio.
 */
export function sniffAudioType(head: Buffer): AudioType | null {
  if (head.length >= 4 && ascii(head, 0, 4) === 'OggS') return 'audio/ogg';
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    // AVIF photos share the container; everything else (M4A, isom, mp42, 3gp) is sound.
    return brand === 'avif' || brand === 'avis' ? null : 'audio/mp4';
  }
  if (head.length >= 6 && ascii(head, 0, 6) === '#!AMR\n') return 'audio/amr';
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE')
    return 'audio/wav';
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  )
    return 'audio/webm';
  if (head.length >= 3 && ascii(head, 0, 3) === 'ID3') return 'audio/mpeg';
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) {
    // Frame sync: layer bits 00 mark an AAC (ADTS) stream, anything else an MPEG audio frame.
    const layer = (head[1]! >> 1) & 0x03;
    return layer === 0 ? 'audio/aac' : 'audio/mpeg';
  }
  return null;
}
