/** One inclusive byte range of a stored object, as HTTP `Range` requests address it. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Reads a `Range: bytes=…` header against an object of `size` bytes (RFC 9110 §14).
 * Returns the range to send, `'unsatisfiable'` when it starts past the end (answer 416),
 * or null to send the whole object: no header, another unit, several ranges, or nonsense.
 * Browsers' media players ask for ranges to find a recording's length and to seek.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    // The last N bytes.
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (m[2] !== '' && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}
