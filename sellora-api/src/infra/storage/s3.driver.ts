import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  StorageDriver,
  type ObjectStream,
  type StoredObject,
  type UploadTarget,
} from './storage.driver.js';

export interface S3DriverOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** CDN or public bucket URL. Without it, public files are served through the API. */
  publicBaseUrl?: string;
  apiPublicUrl: string;
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof NotFound ||
    (err instanceof S3ServiceException &&
      (err.name === 'NoSuchKey' || err.$metadata.httpStatusCode === 404))
  );
}

/**
 * Any S3-compatible service. Browsers upload straight to the bucket with a presigned PUT
 * whose signature covers the content type and length, so the API never carries the bytes.
 * The bucket needs a CORS rule allowing PUT from the web app's origin.
 */
export class S3StorageDriver extends StorageDriver {
  readonly name = 's3' as const;
  readonly client: S3Client;

  constructor(private readonly opts: S3DriverOptions) {
    super();
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async createUpload(
    key: string,
    contentType: string,
    size: number,
    expiresInSeconds: number,
  ): Promise<UploadTarget> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: size,
      }),
      {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return {
      method: 'PUT',
      url,
      headers: { 'content-type': contentType },
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async putFile(key: string, path: string, contentType: string): Promise<void> {
    const { size } = await stat(path);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentType: contentType,
        ContentLength: size,
      }),
    );
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      );
      return { size: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async readStart(key: string, bytes: number): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
    );
    return Buffer.from((await res.Body?.transformToByteArray()) ?? []);
  }

  async open(key: string): Promise<ObjectStream | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      );
      if (!res.Body) return null;
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType,
        body: res.Body as Readable,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }

  publicUrl(key: string): string {
    return this.opts.publicBaseUrl
      ? `${this.opts.publicBaseUrl.replace(/\/+$/, '')}/${key}`
      : `${this.opts.apiPublicUrl}/v1/storage/${key}`;
  }
}
