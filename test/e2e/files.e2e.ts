import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UrlSigner } from '../../src/infra/storage/signing.js';
import { FilesService } from '../../src/modules/files/files.service.js';
import { TestApp, type Session } from '../helpers/test-app.js';

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface FileDto {
  id: string;
  status: string;
  url: string | null;
  size: number;
  inUse: boolean;
}
interface UploadDto {
  file: FileDto;
  upload: { method: string; url: string; headers: Record<string, string>; expiresAt: string };
}

describe('file storage (local driver)', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let platform: string;

  const O = () => t.as(owner.token);
  const url = (path: string) => `/v1/orgs/${orgId}${path}`;
  const pathOf = (absolute: string) => new URL(absolute).pathname + new URL(absolute).search;

  const startUpload = (body: Record<string, unknown> = {}) =>
    O()
      .post(url('/files/uploads'))
      .send({
        purpose: 'product_image',
        filename: 'kurti.png',
        contentType: 'image/png',
        size: PNG.length,
        ...body,
      });

  const put = (target: UploadDto['upload'], bytes: Buffer, contentType?: string) =>
    t
      .http()
      .put(pathOf(target.url))
      .set('content-type', contentType ?? target.headers['content-type']!)
      .send(bytes);

  /** Upload a real PNG all the way to ready. */
  const uploadPng = async (): Promise<FileDto> => {
    const started = (await startUpload().expect(201)).body as UploadDto;
    await put(started.upload, PNG).expect(204);
    return (
      await O()
        .post(url(`/files/${started.file.id}/complete`))
        .expect(200)
    ).body as FileDto;
  };

  const usedBytes = async () =>
    ((await O().get(url('/files/usage')).expect(200)).body as { usedBytes: number }).usedBytes;

  const setOverrides = (body: Record<string, unknown>) =>
    t
      .as(platform)
      .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
      .send({ note: 'storage test', ...body })
      .expect(200);

  beforeAll(async () => {
    t = await TestApp.create({ API_PUBLIC_URL: 'http://api.test' });
    owner = await t.registerUser({ name: 'Owner' });
    orgId = (await t.createOrg(owner, { name: 'Photo Shop' })).id;
    platform = (await t.platformOwner()).token;
    await Promise.all(['StoredFile', 'StorageUsage'].map((m) => t.db.model(m).init()));
  });
  afterAll(async () => {
    await t.close();
  });

  it('uploads a photo, checks it, and serves it with safe headers', async () => {
    const started = (await startUpload().expect(201)).body as UploadDto;
    expect(started.file).toMatchObject({ status: 'pending', url: null, size: PNG.length });
    expect(started.upload).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
    });
    expect(started.upload.url).toMatch(/^http:\/\/api\.test\/v1\/storage\/uploads\//);
    expect(await usedBytes()).toBe(PNG.length);

    // Not uploaded yet.
    const early = await O()
      .post(url(`/files/${started.file.id}/complete`))
      .expect(409);
    expect(early.body.code).toBe('upload_not_received');

    await put(started.upload, PNG).expect(204);
    // Each link writes once.
    const again = await put(started.upload, PNG).expect(409);
    expect(again.body.code).toBe('upload_already_received');

    const ready = (
      await O()
        .post(url(`/files/${started.file.id}/complete`))
        .expect(200)
    ).body as FileDto;
    expect(ready.status).toBe('ready');
    expect(ready.url).toMatch(
      new RegExp(`^http://api\\.test/v1/storage/o/${orgId}/products/${ready.id}\\.png$`),
    );
    // Completing twice is harmless.
    await O()
      .post(url(`/files/${started.file.id}/complete`))
      .expect(200);

    const served = await t
      .http()
      .get(pathOf(ready.url!))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(served.body as Buffer, PNG)).toBe(0);
    expect(served.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    expect(served.headers['content-security-policy']).toContain('sandbox');
    expect(await usedBytes()).toBe(PNG.length);
  });

  it('refuses unsupported types, oversize files and bad upload bodies', async () => {
    const pdf = await startUpload({ contentType: 'application/pdf' }).expect(422);
    expect(pdf.body.errors[0].path).toBe('contentType');
    const svg = await startUpload({ contentType: 'image/svg+xml' }).expect(422);
    expect(svg.body.errors[0].path).toBe('contentType');
    const big = await startUpload({ size: 11 * 1024 * 1024 }).expect(422);
    expect(big.body.errors[0].path).toBe('size');

    const started = (await startUpload().expect(201)).body as UploadDto;
    // Wrong content type for the link.
    expect((await put(started.upload, PNG, 'image/jpeg').expect(422)).body.code).toBe(
      'upload_type_mismatch',
    );
    // More bytes than the link allows.
    expect(
      (await put(started.upload, Buffer.concat([PNG, Buffer.alloc(10)])).expect(422)).body.code,
    ).toBe('upload_size_mismatch');
    // A forged token and an expired one.
    const token = started.upload.url.split('/uploads/')[1]!;
    const forged = `${token.split('.')[0]}.${Buffer.from('nope').toString('base64url')}`;
    await t
      .http()
      .put(`/v1/storage/uploads/${forged}`)
      .set('content-type', 'image/png')
      .send(PNG)
      .expect(403);
    const signer = t.app.get(UrlSigner);
    const claims = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const expired = signer.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 5 });
    await t
      .http()
      .put(`/v1/storage/uploads/${expired}`)
      .set('content-type', 'image/png')
      .send(PNG)
      .expect(403);
    // The right bytes still go through after the failed attempts, also from a browser that
    // sends its session cookies along (the link is the authority, so no CSRF header is needed).
    await put(started.upload, PNG)
      .set('cookie', `sl_at=${owner.token}; sl_csrf=abc`)
      .set('origin', 'http://localhost:3000')
      .expect(204);
  });

  it('rejects a file that is not really the image it claims to be, and frees its space', async () => {
    const before = await usedBytes();
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const started = (await startUpload({ size: html.length }).expect(201)).body as UploadDto;
    expect(await usedBytes()).toBe(before + html.length);
    await put(started.upload, html).expect(204);
    const res = await O()
      .post(url(`/files/${started.file.id}/complete`))
      .expect(422);
    expect(res.body.code).toBe('upload_type_mismatch');
    await O()
      .get(url(`/files/${started.file.id}`))
      .expect(404);
    expect(await usedBytes()).toBe(before);
    const key = `o/${orgId}/products/${started.file.id}.png`;
    await t.http().get(`/v1/storage/${key}`).expect(404);
  });

  it('serves nothing outside the storage key format', async () => {
    for (const path of [
      '/v1/storage/../../etc/passwd',
      '/v1/storage/%2e%2e/%2e%2e/etc/passwd',
      `/v1/storage/o/${orgId}/products/notanid.png`,
      `/v1/storage/o/${orgId}/products/${new Types.ObjectId().toHexString()}.png`,
      `/v1/storage/o/${orgId}/products/${new Types.ObjectId().toHexString()}.svg`,
    ])
      await t.http().get(path).expect(404);
  });

  it('keeps storage within the plan limit, even with uploads racing', async () => {
    const used = await usedBytes();
    // Room for exactly 3 more uploads of 300,000 bytes.
    const mb = Math.ceil((used + 900_000) / (1024 * 1024));
    const room = mb * 1024 * 1024 - used;
    const size = Math.floor(room / 3.5);
    await setOverrides({ limits: { storageMb: mb } });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => startUpload({ size }).then((r) => r.status)),
    );
    expect(results.filter((s) => s === 201)).toHaveLength(3);
    expect(results.filter((s) => s === 402)).toHaveLength(5);
    const refused = await startUpload({ size }).expect(402);
    expect(refused.body).toMatchObject({ code: 'plan_limit_reached', limit: 'storageMb', max: mb });
    expect(await usedBytes()).toBe(used + 3 * size);
    const usage = (await O().get(url('/files/usage')).expect(200)).body as {
      limitBytes: number;
    };
    expect(usage.limitBytes).toBe(mb * 1024 * 1024);

    // Abandoned uploads are swept once their link and grace time have passed.
    const swept = await t.app.get(FilesService).sweep(new Date(Date.now() + 2 * 3600_000));
    expect(swept.expired).toBeGreaterThanOrEqual(3);
    expect(await usedBytes()).toBeLessThanOrEqual(used);
    await setOverrides({ limits: { storageMb: null } });
  });

  it('uses uploaded photos on products, keeps photos shown on orders, and removes the rest', async () => {
    const a = await uploadPng();
    const b = await uploadPng();
    const product = (
      await O()
        .post(url('/products'))
        .send({
          name: 'Photo Kurti',
          images: [
            { fileId: a.id },
            { fileId: b.id, alt: 'Back' },
            { url: 'https://cdn.example.com/x.jpg' },
          ],
          variants: [{ priceMinor: 100_000, stock: 5 }],
        })
        .expect(201)
    ).body as {
      id: string;
      variants: { id: string }[];
      images: { url: string; fileId: string | null }[];
    };
    expect(product.images).toEqual([
      { url: a.url, fileId: a.id, alt: '' },
      { url: b.url, fileId: b.id, alt: 'Back' },
      { url: 'https://cdn.example.com/x.jpg', fileId: null, alt: '' },
    ]);
    expect(
      (
        await O()
          .get(url(`/files/${a.id}`))
          .expect(200)
      ).body.inUse,
    ).toBe(true);
    const inUse = await O()
      .delete(url(`/files/${a.id}`))
      .expect(409);
    expect(inUse.body.code).toBe('file_in_use');

    // An order shows the first photo, so it must outlive its removal from the product.
    await O()
      .post(url('/orders'))
      .send({
        customer: { name: 'Nadia', phone: '01911111111' },
        shippingAddress: { line1: 'Road 3', city: 'Dhaka' },
        items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 1 }],
      })
      .expect(201);

    const before = await usedBytes();
    await O()
      .patch(url(`/products/${product.id}`))
      .send({ images: [] })
      .expect(200);
    // a is on an order: kept and still served. b is used by nothing: deleted.
    expect(
      (
        await O()
          .get(url(`/files/${a.id}`))
          .expect(200)
      ).body.inUse,
    ).toBe(true);
    await t.http().get(pathOf(a.url!)).expect(200);
    await O()
      .get(url(`/files/${b.id}`))
      .expect(404);
    await t.http().get(pathOf(b.url!)).expect(404);
    expect(await usedBytes()).toBe(before - PNG.length);
  });

  it('refuses photos that are still uploading or belong to another business', async () => {
    const pending = (await startUpload().expect(201)).body as UploadDto;
    const res = await O()
      .post(url('/products'))
      .send({
        name: 'Half Uploaded',
        images: [{ url: 'https://cdn.example.com/y.jpg' }, { fileId: pending.file.id }],
        variants: [{ priceMinor: 1_000, stock: 1 }],
      })
      .expect(422);
    expect(res.body.errors[0].path).toBe('images.1.fileId');

    const other = await t.registerUser({ name: 'Other' });
    const otherOrg = (await t.createOrg(other, { name: 'Other Shop' })).id;
    const theirs = (
      await t
        .as(other.token)
        .post(`/v1/orgs/${otherOrg}/files/uploads`)
        .send({
          purpose: 'product_image',
          filename: 'a.png',
          contentType: 'image/png',
          size: PNG.length,
        })
        .expect(201)
    ).body as UploadDto;
    await put(theirs.upload, PNG).expect(204);
    await t
      .as(other.token)
      .post(`/v1/orgs/${otherOrg}/files/${theirs.file.id}/complete`)
      .expect(200);
    const stolen = await O()
      .post(url('/products'))
      .send({
        name: 'Stolen Photo',
        images: [{ fileId: theirs.file.id }],
        variants: [{ priceMinor: 1_000, stock: 1 }],
      })
      .expect(422);
    expect(stolen.body.errors[0].path).toBe('images.0.fileId');
    await O()
      .get(url(`/files/${theirs.file.id}`))
      .expect(404);
  });

  it('deletes a product’s photos with the product, and sweeps photos never used', async () => {
    const photo = await uploadPng();
    const product = (
      await O()
        .post(url('/products'))
        .send({
          name: 'Short Lived',
          images: [{ fileId: photo.id }],
          variants: [{ priceMinor: 1_000, stock: 1 }],
        })
        .expect(201)
    ).body as { id: string };
    await O()
      .delete(url(`/products/${product.id}`))
      .expect(200);
    await O()
      .get(url(`/files/${photo.id}`))
      .expect(404);

    const unused = await uploadPng();
    const files = t.app.get(FilesService);
    // Fresh uploads get a day to be used.
    await files.sweep(new Date());
    await O()
      .get(url(`/files/${unused.id}`))
      .expect(200);
    const swept = await files.sweep(new Date(Date.now() + 25 * 3600_000));
    expect(swept.unused).toBeGreaterThanOrEqual(1);
    await O()
      .get(url(`/files/${unused.id}`))
      .expect(404);
  });

  it('applies permissions and the plan module', async () => {
    const viewer = await t.addMember(owner, orgId, 'viewer');
    const res = await t
      .as(viewer.token)
      .post(url('/files/uploads'))
      .send({ purpose: 'product_image', filename: 'a.png', contentType: 'image/png', size: 10 })
      .expect(403);
    expect(res.body.code).toBe('missing_permission');

    await setOverrides({ removeModules: ['commerce'] });
    const blocked = await startUpload().expect(402);
    expect(blocked.body.code).toBe('module_not_in_plan');
    await setOverrides({ removeModules: [] });
    await startUpload().expect(201);
  });
});
