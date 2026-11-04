import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type DecipherGCM,
} from 'node:crypto';
import { Readable, Transform, type Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { mongo } from 'mongoose';

/**
 * The `slbk/1` backup file (ADR 0020): `SLBK0001`, one byte with the key id's length, the key
 * id, a 12-byte IV, AES-256-GCM ciphertext of gzip'd JSON lines, and the 16-byte GCM tag.
 * Lines: a manifest, one `{"c": collection, "d": canonical EJSON}` per document, an end line.
 */
export const MAGIC = Buffer.from('SLBK0001', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const { EJSON } = mongo.BSON;

export interface BackupKey {
  kid: string;
  key: Buffer;
}

export interface CollectionInfo {
  name: string;
  /** createCollection options that matter for a restore (time series, capped, validator). */
  options: Record<string, unknown>;
  indexes: Record<string, unknown>[];
}

export interface BackupManifest {
  t: 'm';
  format: 'slbk/1';
  scope: 'platform' | 'tenant';
  orgId: string | null;
  createdAt: string;
  database: string;
  collections: CollectionInfo[];
}

export interface BackupEnd {
  t: 'e';
  counts: Record<string, number>;
  docs: number;
}

export type BackupLine =
  BackupManifest | BackupEnd | { t: 'd'; c: string; d: Record<string, unknown> };

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

/** Encrypts what passes through, after a header, and adds the GCM tag at the end. */
function encryptor(key: BackupKey): Transform {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv);
  const kid = Buffer.from(key.kid, 'utf8');
  if (kid.length > 255) throw new BackupFormatError('Key id too long');
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      if (!started) {
        started = true;
        this.push(Buffer.concat([MAGIC, Buffer.from([kid.length]), kid, iv]));
      }
      done(null, cipher.update(chunk));
    },
    flush(done) {
      if (!started) this.push(Buffer.concat([MAGIC, Buffer.from([kid.length]), kid, iv]));
      this.push(cipher.final());
      done(null, cipher.getAuthTag());
    },
  });
}

/** Reads the header, decrypts, and checks the GCM tag at the end (an error when wrong). */
function decryptor(keys: (kid: string) => Buffer | undefined): Transform {
  let header: Buffer | null = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let held = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      try {
        if (header) {
          header = Buffer.concat([header, chunk]);
          if (header.length < MAGIC.length + 1) return done();
          if (!header.subarray(0, MAGIC.length).equals(MAGIC))
            throw new BackupFormatError('Not a Sellora backup file');
          const kidLen = header[MAGIC.length]!;
          const start = MAGIC.length + 1;
          if (header.length < start + kidLen + IV_BYTES) return done();
          const kid = header.subarray(start, start + kidLen).toString('utf8');
          const key = keys(kid);
          if (!key) throw new BackupFormatError(`No backup key "${kid}" on this server`);
          const iv = header.subarray(start + kidLen, start + kidLen + IV_BYTES);
          decipher = createDecipheriv('aes-256-gcm', key, iv);
          chunk = header.subarray(start + kidLen + IV_BYTES);
          header = null;
        }
        // The last 16 bytes are the tag, so always hold them back.
        const all = Buffer.concat([held, chunk]);
        const cut = Math.max(0, all.length - TAG_BYTES);
        held = all.subarray(cut);
        done(null, decipher!.update(all.subarray(0, cut)));
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done) {
      try {
        if (!decipher || held.length !== TAG_BYTES)
          throw new BackupFormatError('The backup file is cut short');
        decipher.setAuthTag(held);
        done(null, decipher.final());
      } catch (err) {
        done(
          err instanceof BackupFormatError
            ? err
            : new BackupFormatError('The backup file is damaged or the key is wrong'),
        );
      }
    },
  });
}

/** Counts bytes and hashes what passes through. */
export function hasher(): Transform & { result: () => { sha256: string; size: number } } {
  const hash = createHash('sha256');
  let size = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  }) as Transform & { result: () => { sha256: string; size: number } };
  let digest: string | null = null;
  t.result = () => {
    digest ??= hash.digest('hex');
    return { sha256: digest, size };
  };
  return t;
}

/**
 * Splits text into lines and parses each, in order. Decodes UTF-8 across chunk boundaries:
 * a Bangla letter or an emoji can be split between two chunks.
 */
function lineParser(): Transform {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  return new Transform({
    readableObjectMode: true,
    transform(chunk: Buffer, _enc, done) {
      try {
        const text = rest + decoder.write(chunk);
        const lines = text.split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) if (line) this.push(parseLine(line));
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done) {
      try {
        rest += decoder.end();
        if (rest) this.push(parseLine(rest));
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  });
}

function parseLine(line: string): BackupLine {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new BackupFormatError('A line of the backup is not valid JSON');
  }
  if (raw.t === 'm' || raw.t === 'e') return raw as unknown as BackupLine;
  if (typeof raw.c !== 'string' || !raw.d || typeof raw.d !== 'object')
    throw new BackupFormatError('A line of the backup is not a document');
  return {
    t: 'd',
    c: raw.c,
    d: EJSON.deserialize(raw.d, { relaxed: false }) as Record<string, unknown>,
  };
}

/** The text of one document line. */
export function documentLine(collection: string, doc: Record<string, unknown>): string {
  return `${JSON.stringify({ c: collection, d: EJSON.serialize(doc, { relaxed: false }) })}\n`;
}

/**
 * Writes a backup to `out`: the lines come from `lines` (each already ends with a newline).
 * Returns the checksum and size of what was written.
 */
export async function writeBackup(
  lines: AsyncIterable<string>,
  out: Writable,
  key: BackupKey,
): Promise<{ sha256: string; size: number }> {
  const tap = hasher();
  await pipeline(
    Readable.from(lines, { objectMode: false }),
    createGzip({ level: 6 }),
    encryptor(key),
    tap,
    out,
  );
  return tap.result();
}

/**
 * Reads a backup file and yields its lines in order. The GCM tag is checked at the very end:
 * only a loop that runs to completion without an error has read an intact file.
 */
export async function* readBackup(
  input: Readable,
  keys: (kid: string) => Buffer | undefined,
  onBytes?: Transform,
): AsyncGenerator<BackupLine> {
  const parser = lineParser();
  let failure: unknown = null;
  const run = onBytes
    ? pipeline(input, onBytes, decryptor(keys), createGunzip(), parser)
    : pipeline(input, decryptor(keys), createGunzip(), parser);
  // Never left unhandled: a caller that stops reading early ends the pipeline on purpose.
  const finished = run.catch((err: unknown) => {
    failure = err;
    parser.destroy(err as Error);
  });
  try {
    for await (const line of parser as AsyncIterable<BackupLine>) yield line;
  } catch (err) {
    await finished;
    throw toFormatError(failure ?? err);
  }
  await finished;
  if (failure) throw toFormatError(failure);
}

function toFormatError(err: unknown): Error {
  if (err instanceof BackupFormatError) return err;
  const code = (err as { code?: string }).code;
  if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR')
    return new BackupFormatError('The backup file is damaged');
  return err as Error;
}

/** A keyring from `kid:base64` pairs; the active key encrypts, every key decrypts. */
export function parseKeyring(
  spec: string,
  activeKid: string,
): { active: BackupKey; all: Map<string, Buffer> } {
  const all = new Map<string, Buffer>();
  for (const pair of spec.split(',')) {
    const [kid, b64] = pair.trim().split(':');
    if (!kid || !b64) throw new Error('Backup keys must be kid:base64key');
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`Backup key "${kid}" must be 32 bytes`);
    all.set(kid, key);
  }
  const active = all.get(activeKid);
  if (!active) throw new Error(`The active backup key "${activeKid}" is not in the list`);
  return { active: { kid: activeKid, key: active }, all };
}
