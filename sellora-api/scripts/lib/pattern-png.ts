/**
 * Draws textile-like pattern images (stripes, checks, borders, dots) as PNG files, so the
 * demo shop has pictures without bundling photos. They are clearly patterns, not product
 * photos: the demo says so.
 */
import { crc32, deflateSync } from 'node:zlib';

export type Rgb = [number, number, number];
export type PatternKind = 'saree' | 'checks' | 'diagonal' | 'dots' | 'kantha' | 'weave';

function hex(c: string): Rgb {
  const n = parseInt(c.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** Encodes RGB pixels as a PNG (8-bit truecolour, no filtering). */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgb,
): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** A square pattern in the given colours (base, contrast, highlight). */
export function patternPng(
  kind: PatternKind,
  colors: [string, string, string],
  size = 640,
  width = size,
): Buffer {
  const [base, second, third] = colors.map(hex) as [Rgb, Rgb, Rgb];
  // Soft light from the top left, so the cloth does not look flat.
  const shade = (c: Rgb, x: number, y: number): Rgb =>
    mix(c, [255, 255, 255], Math.max(0, 0.12 - ((x + y) / (width + size)) * 0.18));
  const draw = (x: number, y: number): Rgb => {
    switch (kind) {
      case 'saree': {
        // A plain body with a wide patterned border (paar) along the bottom.
        const border = size * 0.72;
        if (y > border) {
          const band = Math.floor((y - border) / 14) % 3;
          if (band === 1) return (Math.floor(x / 12) + Math.floor(y / 12)) % 2 ? third : second;
          return second;
        }
        const buti = (x % 64) - 32;
        const butiY = (y % 64) - 32;
        return buti * buti + butiY * butiY < 36 ? third : base;
      }
      case 'checks': {
        const a = Math.floor(x / 40) % 2;
        const b = Math.floor(y / 40) % 2;
        if (x % 40 < 3 || y % 40 < 3) return third;
        return a === b ? base : mix(base, second, 0.6);
      }
      case 'diagonal': {
        const d = (x + y) % 56;
        return d < 18 ? second : d < 24 ? third : base;
      }
      case 'dots': {
        const dx = (x % 48) - 24;
        const dy = (y % 48) - 24;
        const r = dx * dx + dy * dy;
        return r < 60 ? second : r < 110 ? third : base;
      }
      case 'kantha': {
        // Running stitches in rows, offset every other row, as in nakshi kantha.
        const row = Math.floor(y / 18);
        const stitch = (x + (row % 2) * 10) % 20 < 11 && y % 18 < 3;
        if (stitch) return row % 4 === 0 ? third : second;
        return base;
      }
      case 'weave': {
        const warp = Math.floor(x / 8) % 2;
        const weft = Math.floor(y / 8) % 2;
        return warp === weft ? base : mix(base, second, 0.45);
      }
    }
  };
  return encodePng(width, size, (x, y) => shade(draw(x, y), x, y));
}
