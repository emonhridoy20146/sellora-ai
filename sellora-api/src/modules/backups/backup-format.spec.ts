import { randomBytes } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import { mongo } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  BackupFormatError,
  MAGIC,
  documentLine,
  parseKeyring,
  readBackup,
  writeBackup,
  type BackupKey,
  type BackupLine,
} from './backup-format.js';

const key: BackupKey = { kid: 'b1', key: randomBytes(32) };
const keys = (kid: string) => (kid === key.kid ? key.key : undefined);

class Sink extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, done: () => void) {
    this.chunks.push(chunk);
    done();
  }
  get bytes() {
    return Buffer.concat(this.chunks);
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- writeBackup takes an async iterable
async function* linesOf(docs: { c: string; d: Record<string, unknown> }[]) {
  yield `${JSON.stringify({ t: 'm', format: 'slbk/1', scope: 'platform', orgId: null, createdAt: new Date(0).toISOString(), database: 'x', collections: [] })}\n`;
  for (const { c, d } of docs) yield documentLine(c, d);
  yield `${JSON.stringify({ t: 'e', counts: {}, docs: docs.length })}\n`;
}

async function write(docs: { c: string; d: Record<string, unknown> }[], k = key) {
  const sink = new Sink();
  const result = await writeBackup(linesOf(docs), sink, k);
  return { bytes: sink.bytes, ...result };
}

/** Feeds the file in small pieces, as a network stream would. */
function chunked(bytes: Buffer, size = 7): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size));
  return Readable.from(parts);
}

async function readAll(input: Readable, k = keys): Promise<BackupLine[]> {
  const out: BackupLine[] = [];
  for await (const line of readBackup(input, k)) out.push(line);
  return out;
}

describe('slbk/1 backup file', () => {
  const id = new mongo.ObjectId();
  const docs = [
    {
      c: 'orders',
      d: {
        _id: id,
        orgId: new mongo.ObjectId(),
        total: mongo.Decimal128.fromString('1250.50'),
        placedAt: new Date('2026-11-01T10:00:00Z'),
        count: new mongo.Long(9007199254740993n),
        note: 'বাংলা text, emoji 🙂 and a "quote"\nwith a newline',
        raw: new mongo.Binary(Buffer.from([0, 1, 2, 255])),
      },
    },
    { c: 'products', d: { _id: 'string-id', price: 1.5, tags: ['a', 'b'], empty: {} } },
  ];

  it('round-trips BSON types exactly, read in small chunks', async () => {
    const { bytes, sha256, size } = await write(docs);
    expect(bytes.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    expect(size).toBe(bytes.length);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    const lines = await readAll(chunked(bytes));
    expect(lines[0]).toMatchObject({ t: 'm', format: 'slbk/1' });
    expect(lines.at(-1)).toMatchObject({ t: 'e', docs: 2 });
    const [orders, products] = lines.slice(1, -1) as Extract<BackupLine, { t: 'd' }>[];
    expect(orders!.c).toBe('orders');
    expect((orders!.d._id as mongo.ObjectId).equals(id)).toBe(true);
    expect(orders!.d.total).toBeInstanceOf(mongo.Decimal128);
    expect(String(orders!.d.total)).toBe('1250.50');
    expect(orders!.d.placedAt).toEqual(new Date('2026-11-01T10:00:00Z'));
    expect(String(orders!.d.count)).toBe('9007199254740993');
    expect(orders!.d.note).toBe(docs[0]!.d.note);
    expect(Buffer.from((orders!.d.raw as mongo.Binary).buffer)).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect(Number(products!.d.price)).toBe(1.5);
    // Byte for byte the same BSON: every type kept (an int stays an int, a double a double).
    for (const [i, line] of [orders!, products!].entries())
      expect(Buffer.from(mongo.BSON.serialize(line.d))).toEqual(
        Buffer.from(mongo.BSON.serialize(docs[i]!.d)),
      );
  });

  it('does not hold the documents in plain text', async () => {
    const { bytes } = await write(docs);
    expect(bytes.includes(Buffer.from('orders'))).toBe(false);
    expect(bytes.includes(Buffer.from('string-id'))).toBe(false);
  });

  it('uses a fresh IV each time', async () => {
    const a = await write(docs);
    const b = await write(docs);
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('rejects a file with one byte changed anywhere', async () => {
    const { bytes } = await write(docs);
    const headerEnd = MAGIC.length + 1 + key.kid.length + 12;
    for (const at of [headerEnd + 3, Math.floor(bytes.length / 2), bytes.length - 1]) {
      const bad = Buffer.from(bytes);
      bad[at] = bad[at]! ^ 0x01;
      await expect(readAll(chunked(bad))).rejects.toBeInstanceOf(BackupFormatError);
    }
  });

  it('rejects a file cut short, even one that still ends on a whole line', async () => {
    const { bytes } = await write(docs);
    for (const cut of [bytes.length - 1, bytes.length - 16, bytes.length - 40, 20])
      await expect(readAll(chunked(bytes.subarray(0, cut)))).rejects.toBeInstanceOf(
        BackupFormatError,
      );
  });

  it('says which key is missing, and rejects the wrong key', async () => {
    const { bytes } = await write(docs);
    await expect(readAll(chunked(bytes), () => undefined)).rejects.toThrow(
      'No backup key "b1" on this server',
    );
    await expect(readAll(chunked(bytes), () => randomBytes(32))).rejects.toThrow(
      'The backup file is damaged or the key is wrong',
    );
  });

  it('rejects something that is not a backup', async () => {
    await expect(readAll(chunked(Buffer.from('PK\x03\x04 not a backup at all')))).rejects.toThrow(
      'Not a Sellora backup file',
    );
  });

  it('can be stopped part way without an unhandled error', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({
      c: 'x',
      d: { _id: i, pad: 'p'.repeat(50) },
    }));
    const { bytes } = await write(many);
    const input = new PassThrough();
    input.end(bytes);
    let seen = 0;
    for await (const line of readBackup(input, keys)) {
      if (line.t === 'd') seen += 1;
      if (seen === 10) break;
    }
    expect(seen).toBe(10);
  });

  it('writes an empty backup that still reads back', async () => {
    const { bytes } = await write([]);
    const lines = await readAll(chunked(bytes));
    expect(lines.map((l) => l.t)).toEqual(['m', 'e']);
  });
});

describe('backup keyring', () => {
  const a = randomBytes(32).toString('base64');
  const b = randomBytes(32).toString('base64');

  it('reads kid:base64 pairs and picks the active key', () => {
    const ring = parseKeyring(`b1:${a}, b2:${b}`, 'b2');
    expect(ring.active.kid).toBe('b2');
    expect(ring.all.size).toBe(2);
    expect(ring.all.get('b1')).toEqual(Buffer.from(a, 'base64'));
  });

  it('refuses short keys, bad pairs and an active key not in the list', () => {
    expect(() => parseKeyring(`b1:${randomBytes(16).toString('base64')}`, 'b1')).toThrow(
      'must be 32 bytes',
    );
    expect(() => parseKeyring('b1', 'b1')).toThrow('kid:base64key');
    expect(() => parseKeyring(`b1:${a}`, 'b9')).toThrow('"b9" is not in the list');
  });
});
