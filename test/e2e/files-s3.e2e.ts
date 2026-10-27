import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp, type Session } from '../helpers/test-app.js';

/**
 * The S3 driver against a real S3-compatible server. Set MINIO_BINARY to a `minio` server
 * binary to run it; the suite starts MinIO on a free port with a throwaway data folder.
 */
const MINIO = process.env.MINIO_BINARY;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

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

describe.skipIf(!MINIO)('file storage (S3 driver, real MinIO)', () => {
  let minio: ChildProcess;
  let dataDir: string;
  let endpoint: string;
  let s3: S3Client;
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  const bucket = 'sellora-test';
  const accessKeyId = 'sellora-test';
  const secretAccessKey = randomBytes(16).toString('hex');

  const O = () => t.as(owner.token);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'sellora-minio-'));
    const port = await freePort();
    endpoint = `http://127.0.0.1:${port}`;
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
      API_PUBLIC_URL: 'http://api.test',
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: endpoint,
      S3_REGION: 'us-east-1',
      S3_BUCKET: bucket,
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
      S3_FORCE_PATH_STYLE: 'true',
    });
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'S3 Shop' })).id;
  }, 60_000);

  afterAll(async () => {
    await t?.close();
    minio?.kill();
    await rm(dataDir, { recursive: true, force: true });
  });

  const start = async (size = PNG.length) =>
    (
      await O()
        .post(url('/files/uploads'))
        .send({ purpose: 'product_image', filename: 'p.png', contentType: 'image/png', size })
        .expect(201)
    ).body as {
      file: { id: string };
      upload: { url: string; headers: Record<string, string> };
    };

  const exists = async (key: string) => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  };

  it('uploads straight to the bucket with a presigned PUT, then serves through the API', async () => {
    const { file, upload } = await start();
    expect(upload.url.startsWith(`${endpoint}/${bucket}/o/${orgId}/products/`)).toBe(true);
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: PNG });
    expect(put.status).toBe(200);
    const ready = await O()
      .post(url(`/files/${file.id}/complete`))
      .expect(200);
    expect(ready.body).toMatchObject({ status: 'ready' });
    // Without S3_PUBLIC_BASE_URL, files are served through the API.
    expect(ready.body.url).toBe(`http://api.test/v1/storage/o/${orgId}/products/${file.id}.png`);
    const served = await t
      .http()
      .get(new URL(ready.body.url as string).pathname)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(served.body as Buffer, PNG)).toBe(0);
    expect(served.headers['content-type']).toBe('image/png');
  });

  it('the bucket refuses a body of another size or type than the signed one', async () => {
    const { upload } = await start();
    const bigger = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: Buffer.concat([PNG, Buffer.alloc(100)]),
    });
    expect(bigger.status).toBe(403);
    const otherType = await fetch(upload.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: PNG,
    });
    expect(otherType.status).toBe(403);
  });

  it('rejects a fake image and deletes it from the bucket', async () => {
    const html = Buffer.from('<html>not a png</html>');
    const { file, upload } = await start(html.length);
    expect(
      (await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: html })).status,
    ).toBe(200);
    const key = `o/${orgId}/products/${file.id}.png`;
    expect(await exists(key)).toBe(true);
    const res = await O()
      .post(url(`/files/${file.id}/complete`))
      .expect(422);
    expect(res.body.code).toBe('upload_type_mismatch');
    expect(await exists(key)).toBe(false);
  });

  it('removes the object when a photo is taken off a product', async () => {
    const { file, upload } = await start();
    await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: PNG });
    await O()
      .post(url(`/files/${file.id}/complete`))
      .expect(200);
    const product = await O()
      .post(url('/products'))
      .send({
        name: 'Bucket Kurti',
        images: [{ fileId: file.id }],
        variants: [{ priceMinor: 1_000, stock: 1 }],
      })
      .expect(201);
    const key = `o/${orgId}/products/${file.id}.png`;
    expect(await exists(key)).toBe(true);
    await O()
      .patch(url(`/products/${product.body.id as string}`))
      .send({ images: [] })
      .expect(200);
    expect(await exists(key)).toBe(false);
  });
});
