import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { crc32, createDeflateRaw } from 'node:zlib';

/** ZIP limits without ZIP64: 4 GB per file and in all, 65,535 files. */
const MAX_32 = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;
/** Bit 3: sizes and CRC follow the data. Bit 11: names are UTF-8. */
const FLAGS = 0x0808;
const DEFLATE = 8;
const VERSION = 20;

export class ZipTooLargeError extends Error {
  constructor() {
    super('The download is larger than 4 GB, which this ZIP format cannot hold');
    this.name = 'ZipTooLargeError';
  }
}

interface Entry {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/** DOS date and time, as ZIP stores them (local wall clock, 2-second steps). */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getFullYear());
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/**
 * Writes a ZIP file to a stream, one entry at a time, each deflated as it streams (sizes and
 * CRC come after the data, so nothing is held in memory). No ZIP64: past 4 GB it throws
 * `ZipTooLargeError`. Call `add` for each file in turn, then `finish`.
 */
export class ZipWriter {
  private offset = 0;
  private readonly entries: Entry[] = [];
  private readonly names = new Set<string>();

  constructor(
    private readonly out: Writable,
    private readonly now = new Date(),
  ) {}

  private async write(buf: Buffer): Promise<void> {
    if (this.offset + buf.length > MAX_32) throw new ZipTooLargeError();
    this.offset += buf.length;
    if (!this.out.write(buf)) await once(this.out, 'drain');
  }

  /** Adds one file. `content` is text, bytes, or an async stream of either. */
  async add(
    name: string,
    content: string | Buffer | AsyncIterable<string | Buffer>,
  ): Promise<void> {
    if (!name || name.startsWith('/') || name.split('/').includes('..'))
      throw new Error(`Not a safe file name in a ZIP: ${name}`);
    if (this.names.has(name)) throw new Error(`${name} is already in the ZIP`);
    if (this.entries.length >= MAX_ENTRIES) throw new Error('Too many files for one ZIP');
    this.names.add(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(this.now);
    const offset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // CRC and sizes (14..25) stay 0: they follow the data.
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    await this.write(Buffer.concat([header, nameBytes]));

    let crc = 0;
    let size = 0;
    let compressed = 0;
    const deflate = createDeflateRaw({ level: 6 });
    const source: AsyncIterable<string | Buffer> | Iterable<string | Buffer> =
      typeof content === 'string' || Buffer.isBuffer(content) ? [content] : content;
    let failure: unknown = null;
    const pump = (async () => {
      for await (const part of source) {
        const chunk = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
        if (!chunk.length) continue;
        crc = crc32(chunk, crc);
        size += chunk.length;
        if (size > MAX_32) throw new ZipTooLargeError();
        if (!deflate.write(chunk)) await once(deflate, 'drain');
      }
      deflate.end();
    })().catch((err: unknown) => {
      // Kept, and thrown below: the reading loop stops when the deflate stream is destroyed.
      failure = err;
      deflate.destroy(err as Error);
    });
    try {
      for await (const chunk of deflate as AsyncIterable<Buffer>) {
        compressed += chunk.length;
        await this.write(chunk);
      }
    } catch (err) {
      await pump;
      if (failure) throw failure as Error;
      throw err;
    }
    await pump;
    if (failure) throw failure as Error;

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);
    this.entries.push({ name: nameBytes, crc: crc >>> 0, compressed, size, offset, time, date });
  }

  /** Writes the central directory and ends the stream. Returns the ZIP's size in bytes. */
  async finish(): Promise<{ size: number; files: number }> {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(VERSION, 4);
      h.writeUInt16LE(VERSION, 6);
      h.writeUInt16LE(FLAGS, 8);
      h.writeUInt16LE(DEFLATE, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.compressed, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      // Extra, comment, disk number, internal and external attributes stay 0.
      h.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([h, e.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    this.out.end();
    await once(this.out, 'finish');
    return { size: this.offset, files: this.entries.length };
  }
}
