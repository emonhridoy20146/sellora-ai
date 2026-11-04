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

const EXT_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_TYPES).map(([type, ext]) => [ext, type]),
);

export function contentTypeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return EXT_TO_TYPE[ext] ?? 'application/octet-stream';
}

/** How many leading bytes `sniffImageType` needs. */
export const SNIFF_BYTES = 32;

/** The image type the bytes really are, or null when they are not a supported image. */
export function sniffImageType(head: Buffer): ImageType | null {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString('latin1');
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return 'image/jpeg';
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (head.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a'))
    return 'image/gif';
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 12 && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12)))
    return 'image/avif';
  return null;
}
