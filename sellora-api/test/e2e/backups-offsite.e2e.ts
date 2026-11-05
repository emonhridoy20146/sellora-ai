import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackupsService } from '../../src/modules/backups/backups.service.js';
import { TestApp } from '../helpers/test-app.js';

/**
 * The off-site copy of each platform backup, to a second S3-compatible bucket (ADR 0020).
 * Set MINIO_BINARY to a `minio` server binary to run it.
 */
const MINIO = process.env.MINIO_BINARY;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(url: string, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`MinIO did not start at ${url}`);
}

describe.skipIf(!MINIO)('off-site backup copies (real MinIO)', () => {
  let minio: ChildProcess;
  let dataDir: string;
  let s3: S3Client;
  let t: TestApp;
  const bucket = 'sellora-offsite-test';
  const accessKeyId = 'sellora-offsite';
  const secretAccessKey = randomBytes(16).toString('hex');

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'sellora-minio-offsite-'));
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    minio = spawn(MINIO!, ['server', dataDir, '--address', `127.0.0.1:${port}`, '--quiet'], {
      env: {
        ...process.env,
        MINIO_ROOT_USER: accessKeyId,
        MINIO_ROOT_PASSWORD: secretAccessKey,
        MINIO_BROWSER: 'off',
      },
      stdio: 'ignore',
    });
    await waitFor(`${endpoint}/minio/health/live`);
    s3 = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    t = await TestApp.create({
      BACKUP_ENCRYPTION_KEYS: `b1:${randomBytes(32).toString('base64')}`,
      BACKUP_ENCRYPTION_ACTIVE_KID: 'b1',
      BACKUP_OFFSITE_S3_ENDPOINT: endpoint,
      BACKUP_OFFSITE_S3_REGION: 'us-east-1',
      BACKUP_OFFSITE_S3_BUCKET: bucket,
      BACKUP_OFFSITE_S3_ACCESS_KEY_ID: accessKeyId,
      BACKUP_OFFSITE_S3_SECRET_ACCESS_KEY: secretAccessKey,
    });
  }, 60_000);

  afterAll(async () => {
    await t?.close();
    // Wait for MinIO to exit before removing its folder; it writes there until it stops.
    if (minio && minio.exitCode === null) {
      const exited = new Promise<void>((resolve) => minio!.once('exit', () => resolve()));
      minio.kill();
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const head = async (key: string) => {
    try {
      return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      return null;
    }
  };

  it('copies each verified platform backup off site, and removes the copy with the backup', async () => {
    const svc = t.app.get(BackupsService);
    const by = { type: 'system' as const, id: 'test' };
    await svc.updateSettings({ keep: { daily: 1, weekly: 0, monthly: 0 } });
    const first = await svc.backUpPlatform('manual', by);
    expect(first.status).toBe('verified');
    expect(first.offsite).toMatchObject({ ok: true, error: null });
    const key = (id: string, at: string) => `backups/platform/${at.slice(0, 4)}/${id}.slbk`;
    expect((await head(key(first.id, first.startedAt)))?.ContentLength).toBe(first.size);

    // With one daily kept, the next backup replaces the first, here and off site.
    const second = await svc.backUpPlatform('manual', by);
    expect(second.offsite?.ok).toBe(true);
    expect((await svc.require(first.id)).status).toBe('deleted');
    expect(await head(key(first.id, first.startedAt))).toBeNull();
    expect(await head(key(second.id, second.startedAt))).not.toBeNull();
  });
});
