import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../common/errors/app-error.js';
import { contentTypeForKey } from './content-types.js';
import {
  StorageDriver,
  type ObjectStream,
  type StoredObject,
  type UploadTarget,
} from './storage.driver.js';
import type { UrlSigner } from './signing.js';

const SAFE_KEY = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.[a-z0-9]{2,5}$/;

interface UploadClaims {
  k: string;
  t: string;
  s: number;
  exp: number;
}

/**
 * Files on this server's disk, for single-server installs and development. Uploads go to
 * the API itself (PUT /v1/storage/uploads/:token) with a signed, single-use token.
 */
export class LocalStorageDriver extends StorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(
    rootDir: string,
    private readonly apiPublicUrl: string,
    private readonly signer: UrlSigner,
  ) {
    super();
    this.root = resolve(rootDir);
  }

  private path(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error(`Unsafe storage key: ${key}`);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`Storage key escapes the root: ${key}`);
    return full;
  }

  createUpload(
    key: string,
    contentType: string,
    size: number,
    expiresInSeconds: number,
  ): Promise<UploadTarget> {
    this.path(key);
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const token = this.signer.sign({
      k: key,
      t: contentType,
      s: size,
      exp: Math.floor(expiresAt.getTime() / 1000),
    });
    return Promise.resolve({
      method: 'PUT',
      url: `${this.apiPublicUrl}/v1/storage/uploads/${token}`,
      headers: { 'content-type': contentType },
      expiresAt,
    });
  }

  /**
   * Writes an upload sent to the API. The body must match the signed type and size exactly,
   * and each token writes once: a second PUT to the same key is refused.
   */
  async receive(
    token: string,
    body: Readable,
    headers: { contentType?: string; contentLength?: string },
  ): Promise<void> {
    const claims = this.signer.verify<UploadClaims>(token);
    if (!claims)
      throw AppError.forbidden('upload_link_invalid', 'This upload link is invalid or expired.');
    if ((headers.contentType ?? '').split(';')[0]!.trim().toLowerCase() !== claims.t)
      throw AppError.unprocessable(
        'upload_type_mismatch',
        `Send the file with Content-Type ${claims.t}.`,
      );
    if (headers.contentLength !== undefined && Number(headers.contentLength) !== claims.s)
      throw AppError.unprocessable(
        'upload_size_mismatch',
        `The file must be exactly ${claims.s} bytes.`,
      );
    const target = this.path(claims.k);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.part-${randomBytes(6).toString('hex')}`;
    let received = 0;
    try {
      await pipeline(
        body,
        async function* limit(source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            received += chunk.length;
            if (received > claims.s)
              throw AppError.unprocessable(
                'upload_size_mismatch',
                `The file must be exactly ${claims.s} bytes.`,
              );
            yield chunk;
          }
        },
        createWriteStream(temp, { flags: 'wx' }),
      );
      if (received !== claims.s)
        throw AppError.unprocessable(
          'upload_size_mismatch',
          `The file must be exactly ${claims.s} bytes.`,
        );
      try {
        await link(temp, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST')
          throw AppError.conflict('upload_already_received', 'This file was already uploaded.');
        throw err;
      }
    } finally {
      await rm(temp, { force: true });
    }
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    // Written beside the target and moved into place, so readers never see half a file.
    const temp = `${target}.part-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(temp, body, { flag: 'wx' });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const s = await stat(this.path(key));
      return s.isFile() ? { size: s.size, contentType: contentTypeForKey(key) } : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async readStart(key: string, bytes: number): Promise<Buffer> {
    const handle = await open(this.path(key), 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async open(key: string): Promise<ObjectStream | null> {
    const meta = await this.head(key);
    if (!meta) return null;
    return { ...meta, body: createReadStream(this.path(key)) };
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  publicUrl(key: string): string {
    return `${this.apiPublicUrl}/v1/storage/${key}`;
  }
}
