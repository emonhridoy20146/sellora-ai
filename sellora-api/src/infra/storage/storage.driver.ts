import type { Readable } from 'node:stream';

/** Where the browser sends the file bytes: one PUT with exactly these headers. */
export interface UploadTarget {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObject {
  size: number;
  contentType?: string;
}

export interface ObjectStream extends StoredObject {
  body: Readable;
}

/**
 * Object storage behind one interface: the local disk for a single server, or any
 * S3-compatible service (AWS S3, Cloudflare R2, MinIO, Backblaze B2). Keys are created by the
 * server only; callers never pass user input as a key.
 */
export abstract class StorageDriver {
  abstract readonly name: 'local' | 's3';

  /** A short-lived URL the browser can PUT one object to, bound to its type and size. */
  abstract createUpload(
    key: string,
    contentType: string,
    size: number,
    expiresInSeconds: number,
  ): Promise<UploadTarget>;

  /**
   * Writes an object the server itself produced (for example a photo a customer sent on
   * WhatsApp). Browsers never write this way; they use `createUpload`.
   */
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;

  /**
   * Writes a large object the server produced from a file on its own disk (a backup), without
   * loading it into memory. One request; S3 allows up to 5 GB.
   */
  abstract putFile(key: string, path: string, contentType: string): Promise<void>;

  /** Size and type of a stored object, or null when it does not exist. */
  abstract head(key: string): Promise<StoredObject | null>;

  /** The first `bytes` bytes of an object, to check what it really is. */
  abstract readStart(key: string, bytes: number): Promise<Buffer>;

  /** Streams an object, or returns null when it does not exist. */
  abstract open(key: string): Promise<ObjectStream | null>;

  /** Deletes an object. Deleting a missing object is not an error. */
  abstract delete(key: string): Promise<void>;

  /** Where browsers load a public object from. */
  abstract publicUrl(key: string): string;
}
