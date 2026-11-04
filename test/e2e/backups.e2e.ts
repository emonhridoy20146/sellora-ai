import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { promisify } from 'node:util';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { StorageDriver } from '../../src/infra/storage/storage.driver.js';
import { RESTORE_PARTS } from '../../src/modules/backups/backup-rules.js';
import { BackupsService, type RunDto } from '../../src/modules/backups/backups.service.js';
import { TestApp, uniqueEmail, type Session } from '../helpers/test-app.js';

/** Reads a whole stream into a buffer. */
async function bytesOf(body: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

const BACKUP_KEYS = `b1:${randomBytes(32).toString('base64')}`;

/** Runs the command-line tool (scripts/backup.ts) as an operator would. */
async function cli(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ['--import', '@swc-node/register/esm-register', 'scripts/backup.ts', ...args],
      { env: { PATH: process.env.PATH, BACKUP_ENCRYPTION_KEYS: BACKUP_KEYS }, timeout: 60_000 },
    );
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('backups (ADR 0020)', () => {
  let t: TestApp;
  let owner: { token: string; secret: string; email: string; password: string };
  let svc: BackupsService;
  let storage: StorageDriver;
  let queue: Queue;
  let a: Session;
  let b: Session;
  let orgA: { id: string; name: string };
  let orgB: { id: string; name: string };
  let first: RunDto;
  const productsA: { id: string; name: string }[] = [];
  const customersA: { id: string; name: string }[] = [];

  const P = () => t.as(owner.token);
  const A = () => t.as(a.token);
  const B = () => t.as(b.token);

  /** A code the server has not seen yet (each code works once; tests run faster than 30 s). */
  const freshCode = async () => {
    await t.db
      .db!.collection('platform_users')
      .updateOne({ email: owner.email }, { $unset: { 'mfa.totpLastStep': 1 } });
    return t.nextTotp(owner.secret);
  };
  const count = (collection: string, orgId: string, filter: Record<string, unknown> = {}) =>
    t.db.db!.collection(collection).countDocuments({ orgId: new Types.ObjectId(orgId), ...filter });

  const product = async (as: () => ReturnType<TestApp['as']>, org: string, name: string) =>
    (
      await as()
        .post(`/v1/orgs/${org}/products`)
        .send({ name, variants: [{ priceMinor: 50_000, stock: 5 }] })
        .expect(201)
    ).body as { id: string; name: string };
  const customer = async (
    as: () => ReturnType<TestApp['as']>,
    org: string,
    name: string,
    phone: string,
  ) =>
    (await as().post(`/v1/orgs/${org}/customers`).send({ name, phone }).expect(201)).body as {
      id: string;
      name: string;
    };

  /** "Back up now" and then the worker's part, as the worker would run it. */
  const backUpNow = async (orgId?: string) => {
    const res = await P()
      .post(orgId ? `/v1/platform/backups/tenants/${orgId}/runs` : '/v1/platform/backups/runs')
      .expect(202);
    return svc.runQueued(res.body.id as string);
  };

  beforeAll(async () => {
    t = await TestApp.create({
      BACKUP_ENCRYPTION_KEYS: BACKUP_KEYS,
      BACKUP_ENCRYPTION_ACTIVE_KID: 'b1',
      BACKUP_TMP_DIR: join(tmpdir(), `sellora-backup-test-${randomBytes(4).toString('hex')}`),
    });
    svc = t.app.get(BackupsService);
    storage = t.app.get(StorageDriver);
    queue = t.app.get<Queue>(getQueueToken(QUEUES.backups));
    owner = await t.platformOwner();
    a = await t.registerUser({ name: 'Owner A' });
    b = await t.registerUser({ name: 'Owner B' });
    orgA = { id: (await t.createOrg(a, { name: 'Shop Alpha' })).id, name: 'Shop Alpha' };
    orgB = { id: (await t.createOrg(b, { name: 'Shop Beta' })).id, name: 'Shop Beta' };
    productsA.push(
      await product(A, orgA.id, 'Jamdani saree'),
      await product(A, orgA.id, 'Silk panjabi'),
    );
    customersA.push(
      await customer(A, orgA.id, 'Rahima Begum', '01711000001'),
      await customer(A, orgA.id, 'Karim Mia', '01711000002'),
    );
    await product(B, orgB.id, 'Beta lamp');
    await customer(B, orgB.id, 'Beta buyer', '01811000001');
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  it('restores only business collections the models really have, each with an orgId', () => {
    const byCollection = new Map(
      Object.values(t.db.models).map((m) => [m.collection.collectionName, m]),
    );
    for (const part of Object.values(RESTORE_PARTS))
      for (const name of part.collections) {
        const model = byCollection.get(name);
        expect(model, name).toBeDefined();
        expect(model!.schema.path('orgId'), name).toBeDefined();
      }
  });

  describe('platform backups', () => {
    it('makes an encrypted backup on request, verifies it, and keeps one going at a time', async () => {
      const res = await P().post('/v1/platform/backups/runs').expect(202);
      expect(res.body).toMatchObject({ scope: 'platform', reason: 'manual', status: 'running' });
      expect(res.body.startedBy).toMatchObject({ type: 'platform', label: owner.email });
      expect(await queue.getJob(`write-${res.body.id}`)).toBeTruthy();
      const again = await P().post('/v1/platform/backups/runs').expect(409);
      expect(again.body.code).toBe('backup_running');

      first = await svc.runQueued(res.body.id);
      expect(first).toMatchObject({ status: 'verified', tiers: ['daily', 'weekly', 'monthly'] });
      expect(first.size).toBeGreaterThan(100);
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(first.counts.products).toBeGreaterThanOrEqual(3);
      expect(first.counts.organizations).toBeGreaterThanOrEqual(2);
      expect(first.counts.backup_runs).toBeGreaterThanOrEqual(1);

      const stored = await storage.open(
        `backups/platform/${first.startedAt.slice(0, 4)}/${first.id}.slbk`,
      );
      const bytes = await bytesOf(stored!.body);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(first.sha256);
      expect(bytes.subarray(0, 8).toString()).toBe('SLBK0001');
      expect(bytes.includes(Buffer.from('Jamdani'))).toBe(false);
      expect(bytes.includes(Buffer.from(owner.email))).toBe(false);
    });

    it('test-restores the weekly copy into a temporary database and drops it', async () => {
      // The first backup was the week's copy, so it was test-restored straight away.
      expect(first.testRestore).toMatchObject({ ok: true, error: null });
      const dbs = await t.db.db!.admin().listDatabases({ nameOnly: true });
      expect(dbs.databases.map((d) => d.name).filter((n) => n.includes('_rt_'))).toEqual([]);

      const res = await P().post(`/v1/platform/backups/runs/${first.id}/test-restore`).expect(202);
      expect(res.body.testRestorePending).toBe(true);
      await P().post(`/v1/platform/backups/runs/${first.id}/test-restore`).expect(202);
      const jobs = (await queue.getJobs(['waiting', 'delayed'])).filter(
        (j) => j.name === 'test-restore',
      );
      expect(jobs).toHaveLength(1);
      const done = await svc.testRestore(first.id);
      expect(done.testRestorePending).toBe(false);
      expect(done.testRestore).toMatchObject({ ok: true });
    });

    it('fails a backup whose stored file was changed, and removes the file', async () => {
      const run = await svc.backUpPlatform('manual', { type: 'system', id: 'test' });
      expect(run.status).toBe('verified');
      const key = `backups/platform/${run.startedAt.slice(0, 4)}/${run.id}.slbk`;
      const bytes = await bytesOf((await storage.open(key))!.body);
      const mid = Math.floor(bytes.length / 2);
      bytes[mid] = bytes[mid]! ^ 0x01;
      const temp = join(tmpdir(), `tampered-${run.id}.slbk`);
      await writeFile(temp, bytes);
      await storage.putFile(key, temp, 'application/octet-stream');
      const checked = await svc.verify(run.id);
      expect(checked.status).toBe('failed');
      expect(checked.error).toMatch(/damaged|checksum/);
      expect(await storage.head(key)).toBeNull();
    });

    it('keeps the newest dailies and the weekly and monthly copies, and deletes the rest', async () => {
      await P()
        .patch('/v1/platform/backups/settings')
        .send({ keep: { daily: 2, weekly: 2, monthly: 2 } })
        .expect(200);
      const by = { type: 'system' as const, id: 'test' };
      // Older backups, in Dhaka: Monday 7 and Tuesday 8 Sep, Monday 14 and Tuesday 15 Sep.
      const at = (day: number) => new Date(`2026-09-${String(day).padStart(2, '0')}T05:00:00Z`);
      const mon1 = await svc.backUpPlatform('manual', by, at(7));
      const tue1 = await svc.backUpPlatform('manual', by, at(8));
      const mon2 = await svc.backUpPlatform('manual', by, at(14));
      const tue2 = await svc.backUpPlatform('manual', by, at(15));
      expect(mon1.tiers).toEqual(['daily', 'weekly', 'monthly']);
      expect(tue1.tiers).toEqual(['daily']);
      expect(mon2.tiers).toEqual(['daily', 'weekly']);
      expect(tue2.tiers).toEqual(['daily']);

      // Kept: the two newest (first, 15 Sep), weekly copies (first, 14 Sep), monthly (first, 7 Sep).
      const runs = (await P().get('/v1/platform/backups/runs?scope=platform&limit=100').expect(200))
        .body as RunDto[];
      const verified = runs.filter((r) => r.status === 'verified').map((r) => r.id);
      expect(verified.sort()).toEqual([first.id, mon1.id, mon2.id, tue2.id].sort());
      const removed = runs.find((r) => r.id === tue1.id)!;
      expect(removed.status).toBe('deleted');
      expect(await storage.head(`backups/platform/2026/${tue1.id}.slbk`)).toBeNull();
      expect(await storage.head(`backups/platform/2026/${mon1.id}.slbk`)).not.toBeNull();
    });
  });

  describe('downloads', () => {
    let run: RunDto;
    beforeAll(async () => {
      run = (await P().get('/v1/platform/backups/runs?scope=platform').expect(200)).body.find(
        (r: RunDto) => r.status === 'verified',
      );
    });

    it('needs a fresh 2-step code and a reason, and the link works once', async () => {
      await P()
        .post(`/v1/platform/backups/runs/${run.id}/download`)
        .send({ reason: 'Moving to a new server' })
        .expect(422);
      const wrong = await P()
        .post(`/v1/platform/backups/runs/${run.id}/download`)
        .send({ code: '000000', reason: 'Moving to a new server' })
        .expect(422);
      expect(wrong.body.errors[0].path).toBe('code');

      const code = await freshCode();
      const res = await P()
        .post(`/v1/platform/backups/runs/${run.id}/download`)
        .send({ code, reason: 'Moving to a new server' })
        .expect(200);
      expect(res.body.filename).toMatch(/^sellora-platform-.*\.slbk$/);
      // The same code cannot be used twice.
      await P()
        .post(`/v1/platform/backups/runs/${run.id}/download`)
        .send({ code, reason: 'Moving to a new server' })
        .expect(422);

      const path = new URL(res.body.url).pathname;
      const file = await t
        .http()
        .get(path)
        .buffer(true)
        .parse((r, done) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(file.headers['content-disposition']).toContain('attachment');
      expect(
        createHash('sha256')
          .update(file.body as Buffer)
          .digest('hex'),
      ).toBe(run.sha256);
      await t.http().get(path).expect(404);
      await t
        .http()
        .get(`${path.slice(0, -3)}abc`)
        .expect(404);

      const audit = await t.db
        .db!.collection('audit_events')
        .findOne({ action: 'platform.backups.downloaded', 'target.id': run.id });
      expect(audit?.metadata).toMatchObject({ reason: 'Moving to a new server' });

      // The downloaded file is checked and restored with the command-line tool, app not needed.
      const saved = join(tmpdir(), `download-${run.id}.slbk`);
      await writeFile(saved, file.body as Buffer);
      const verified = await cli(['verify', saved]);
      expect(verified.code, verified.out).toBe(0);
      expect(verified.out).toContain('OK: an intact platform backup');
      expect(verified.out).toContain(run.sha256!);
      const dbName = `sellora_cli_${randomBytes(4).toString('hex')}`;
      const uri = inject('mongoUri');
      const restored = await cli(['restore', saved, '--uri', uri, '--db', dbName]);
      expect(restored.code, restored.out).toBe(0);
      const target = t.db.getClient().db(dbName);
      try {
        expect(await target.collection('products').countDocuments()).toBe(run.counts.products);
        expect(await target.collection('organizations').countDocuments()).toBe(
          run.counts.organizations,
        );
        const indexes = await target.collection('platform_users').indexes();
        expect(indexes.some((i) => i.unique)).toBe(true);
        // A database that already has data is refused.
        const again = await cli(['restore', saved, '--uri', uri, '--db', dbName]);
        expect(again.code).toBe(1);
        expect(again.out).toContain('Restore into a new, empty database');
        // A changed byte is caught.
        const bad = Buffer.from(file.body as Buffer);
        bad[bad.length - 3] = bad[bad.length - 3]! ^ 0x01;
        await writeFile(saved, bad);
        const damaged = await cli(['verify', saved]);
        expect(damaged.code).toBe(1);
        expect(damaged.out).toMatch(/damaged/);
      } finally {
        await target.dropDatabase();
        await rm(saved, { force: true });
      }
    }, 120_000);

    it('is only for admins who manage backups', async () => {
      const email = uniqueEmail('support');
      await P()
        .post('/v1/platform/admins')
        .send({ email, name: 'Support', role: 'support' })
        .expect(201);
      const token = await t.lastTokenFromMail(email, 'platform.setup');
      const support = await t.completePlatformAccount(email, 'a long platform passphrase', token);
      await t.as(support.token).get('/v1/platform/backups/runs').expect(403);
      await t.as(support.token).post('/v1/platform/backups/runs').expect(403);
      await t.as(support.token).get(`/v1/platform/backups/tenants/${orgA.id}`).expect(403);
      // Merchant tokens are not platform tokens.
      const merchant = await A().get('/v1/platform/backups/runs');
      expect([401, 403]).toContain(merchant.status);
    });
  });

  describe('restoring one business', () => {
    let point: RunDto;
    let restoreId: string;
    let newProduct: { id: string };
    let betaProduct: { id: string };

    beforeAll(async () => {
      point = await backUpNow();
      expect(point.status).toBe('verified');
      // After the backup: A deletes a product, adds one and renames a customer; B adds one.
      await A().delete(`/v1/orgs/${orgA.id}/products/${productsA[0]!.id}`).expect(200);
      newProduct = await product(A, orgA.id, 'New kurti');
      await A()
        .patch(`/v1/orgs/${orgA.id}/customers/${customersA[0]!.id}`)
        .send({ name: 'Rahima (renamed)' })
        .expect(200);
      betaProduct = await product(B, orgB.id, 'Beta chair');
    });

    it('previews what each part would add, replace and remove', async () => {
      const res = await P()
        .post(`/v1/platform/backups/tenants/${orgA.id}/preview`)
        .send({ runId: point.id })
        .expect(200);
      expect(res.body.business).toEqual({ id: orgA.id, name: orgA.name });
      const products = res.body.parts.find((p: { part: string }) => p.part === 'products');
      const row = products.collections.find(
        (c: { collection: string }) => c.collection === 'products',
      );
      expect(row).toEqual({
        collection: 'products',
        inBackup: 2,
        now: 2,
        added: 1,
        replaced: 1,
        removed: 1,
      });
      const customers = res.body.parts.find((p: { part: string }) => p.part === 'customers');
      expect(customers).toMatchObject({ inBackup: 2, now: 2, added: 0, replaced: 2, removed: 0 });
    });

    it('needs the name typed, a reason and a fresh code', async () => {
      const body = { runId: point.id, parts: ['products'], reason: 'Merchant deleted by mistake' };
      await P()
        .post(`/v1/platform/backups/tenants/${orgA.id}/restores`)
        .send({ ...body, confirmName: orgA.name })
        .expect(422);
      const wrongName = await P()
        .post(`/v1/platform/backups/tenants/${orgA.id}/restores`)
        .send({ ...body, confirmName: 'Shop Alph', code: await freshCode() })
        .expect(422);
      expect(wrongName.body.errors[0].path).toBe('confirmName');
      await P()
        .post(`/v1/platform/backups/tenants/${orgA.id}/restores`)
        .send({ ...body, parts: ['payments'], confirmName: orgA.name, code: await freshCode() })
        .expect(422);
    });

    it('restores the chosen part of that business only, after a safety backup', async () => {
      const res = await P()
        .post(`/v1/platform/backups/tenants/${orgA.id}/restores`)
        .send({
          runId: point.id,
          parts: ['products'],
          reason: 'Merchant deleted by mistake',
          confirmName: orgA.name,
          code: await freshCode(),
        })
        .expect(202);
      expect(res.body.status).toBe('running');
      restoreId = res.body.id;
      const twice = await P()
        .post(`/v1/platform/backups/tenants/${orgA.id}/restores`)
        .send({
          runId: point.id,
          parts: ['products'],
          reason: 'Merchant deleted by mistake',
          confirmName: orgA.name,
          code: await freshCode(),
        })
        .expect(409);
      expect(twice.body.code).toBe('restore_running');
      const betaBefore = await count('products', orgB.id);

      const done = await svc.runRestore(restoreId);
      expect(done).toMatchObject({ status: 'done', error: null, parts: ['products'] });
      expect(done.restored.products).toBe(2);
      expect(done.removed.products).toBe(2);

      // A's products are as in the backup: the deleted one back, the new one gone.
      const ids = (
        await t.db
          .db!.collection('products')
          .find({ orgId: new Types.ObjectId(orgA.id) })
          .toArray()
      ).map((d) => String(d._id));
      expect(ids.sort()).toEqual(productsA.map((p) => p.id).sort());
      expect(ids).not.toContain(newProduct.id);
      // Customers were not chosen, so the rename stays.
      const rahima = await t.db
        .db!.collection('customers')
        .findOne({ _id: new Types.ObjectId(customersA[0]!.id) });
      expect(rahima?.name).toBe('Rahima (renamed)');
      // The other business is untouched.
      expect(await count('products', orgB.id)).toBe(betaBefore);
      expect(
        await t.db
          .db!.collection('products')
          .countDocuments({ _id: new Types.ObjectId(betaProduct.id) }),
      ).toBe(1);
      // The restored products work through the app again.
      const listed = await A().get(`/v1/orgs/${orgA.id}/products?limit=50`).expect(200);
      expect(listed.body.items.map((p: { id: string }) => p.id)).toContain(productsA[0]!.id);

      // The safety backup holds A as it was just before.
      const safety = await svc.require(done.safetyRunId!);
      expect(safety).toMatchObject({
        scope: 'tenant',
        orgId: orgA.id,
        reason: 'safety',
        status: 'verified',
      });
      expect(safety.counts.products).toBe(2);
      expect(safety.counts.organizations).toBe(1);
      expect(Object.keys(safety.counts)).not.toContain('platform_users');

      const platformAudit = await t.db
        .db!.collection('audit_events')
        .findOne({ action: 'platform.backups.business_restored', 'target.id': orgA.id });
      expect(platformAudit?.actor).toMatchObject({ type: 'platform', label: owner.email });
      const tenantAudit = await t.db
        .db!.collection('audit_events')
        .findOne({ action: 'backup.restored', orgId: new Types.ObjectId(orgA.id) });
      expect(tenantAudit).toBeTruthy();
      const mails = await t.outbox(a.email);
      expect(
        mails.find((m) => m.category === 'security' && /restored/i.test(m.subject)),
      ).toBeTruthy();

      const listing = await P().get(`/v1/platform/backups/tenants/${orgA.id}`).expect(200);
      expect(listing.body.restores[0]).toMatchObject({ id: restoreId, status: 'done' });
      expect(listing.body.points.map((r: RunDto) => r.id)).toEqual(
        expect.arrayContaining([point.id, done.safetyRunId]),
      );
      // B's list holds platform backups but not A's own.
      const beta = await P().get(`/v1/platform/backups/tenants/${orgB.id}`).expect(200);
      expect(beta.body.points.map((r: RunDto) => r.id)).not.toContain(done.safetyRunId);
      expect(beta.body.restores).toEqual([]);
    });

    it('undoes a restore from its safety backup, and never restores one business from another', async () => {
      const { safetyRunId } = (await P().get(`/v1/platform/backups/tenants/${orgA.id}`).expect(200))
        .body.restores[0] as { safetyRunId: string };
      const wrong = await P()
        .post(`/v1/platform/backups/tenants/${orgB.id}/restores`)
        .send({
          runId: safetyRunId,
          parts: ['products'],
          reason: 'Trying the wrong business',
          confirmName: orgB.name,
          code: await freshCode(),
        })
        .expect(409);
      expect(wrong.body.code).toBe('backup_other_business');
      await P()
        .post(`/v1/platform/backups/tenants/${orgB.id}/preview`)
        .send({ runId: safetyRunId })
        .expect(409);

      const res = await P()
        .post(`/v1/platform/backups/tenants/${orgA.id}/restores`)
        .send({
          runId: safetyRunId,
          parts: ['products'],
          reason: 'Undo the restore',
          confirmName: orgA.name,
          code: await freshCode(),
        })
        .expect(202);
      expect((await svc.runRestore(res.body.id)).status).toBe('done');
      const ids = (
        await t.db
          .db!.collection('products')
          .find({ orgId: new Types.ObjectId(orgA.id) })
          .toArray()
      ).map((d) => String(d._id));
      expect(ids.sort()).toEqual([productsA[1]!.id, newProduct.id].sort());
    });

    it('changes nothing when the backup file is damaged', async () => {
      const own = await backUpNow(orgA.id);
      expect(own).toMatchObject({ scope: 'tenant', orgId: orgA.id, status: 'verified' });
      const key = `backups/orgs/${orgA.id}/${own.id}.slbk`;
      const bytes = await bytesOf((await storage.open(key))!.body);
      bytes[bytes.length - 5] = bytes[bytes.length - 5]! ^ 0x01;
      const temp = join(tmpdir(), `tampered-${own.id}.slbk`);
      await writeFile(temp, bytes);
      await storage.putFile(key, temp, 'application/octet-stream');
      const before = await count('products', orgA.id);
      const safetyBefore = await t.db
        .db!.collection('backup_runs')
        .countDocuments({ reason: 'safety' });

      const res = await P()
        .post(`/v1/platform/backups/tenants/${orgA.id}/restores`)
        .send({
          runId: own.id,
          parts: ['products', 'customers'],
          reason: 'Restore from damaged file',
          confirmName: orgA.name,
          code: await freshCode(),
        })
        .expect(202);
      const done = await svc.runRestore(res.body.id);
      expect(done.status).toBe('failed');
      expect(done.error).toMatch(/damaged/);
      expect(done.error).not.toMatch(/safety backup/);
      expect(await count('products', orgA.id)).toBe(before);
      expect(await t.db.db!.collection('backup_runs').countDocuments({ reason: 'safety' })).toBe(
        safetyBefore,
      );
      // The business is unlocked again.
      const unlocked = await P()
        .post(`/v1/platform/backups/tenants/${orgA.id}/restores`)
        .send({
          runId: point.id,
          parts: ['customers'],
          reason: 'Put the customers back',
          confirmName: orgA.name,
          code: await freshCode(),
        })
        .expect(202);
      expect((await svc.runRestore(unlocked.body.id)).status).toBe('done');
      const rahima = await t.db
        .db!.collection('customers')
        .findOne({ _id: new Types.ObjectId(customersA[0]!.id) });
      expect(rahima?.name).toBe('Rahima Begum');
    });
  });

  describe('the nightly sweep', () => {
    it('starts the nightly backup once, and marks interrupted runs failed', async () => {
      await P().patch('/v1/platform/backups/settings').send({ enabled: true, hour: 3 }).expect(200);
      await t.db.db!.collection('backup_runs').insertOne({
        scope: 'platform',
        reason: 'manual',
        status: 'running',
        tiers: [],
        startedAt: new Date(Date.now() - 3600_000),
        lockKey: 'platform',
        leaseUntil: new Date(Date.now() - 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const now = new Date();
      const firstSweep = await svc.sweep(now);
      expect(firstSweep.interrupted).toBe(1);
      expect(firstSweep.started).toBe(true);
      const second = await svc.sweep(new Date(now.getTime() + 60_000));
      expect(second.started).toBe(false);
      const runs = (await P().get('/v1/platform/backups/runs?scope=platform&limit=100').expect(200))
        .body as RunDto[];
      expect(runs.find((r) => r.error?.startsWith('Interrupted'))?.status).toBe('failed');
      expect(runs.filter((r) => r.reason === 'scheduled')).toHaveLength(1);
      expect(runs.find((r) => r.reason === 'scheduled')?.status).toBe('verified');
    });

    it('turns off and keeps its settings', async () => {
      const res = await P()
        .patch('/v1/platform/backups/settings')
        .send({ enabled: false, timezone: 'Asia/Dhaka' })
        .expect(200);
      expect(res.body).toMatchObject({
        enabled: false,
        hour: 3,
        keyId: 'b1',
        offsiteConfigured: false,
      });
      await P()
        .patch('/v1/platform/backups/settings')
        .send({ timezone: 'Mars/Olympus' })
        .expect(422);
      expect((await svc.sweep(new Date(Date.now() + 2 * 24 * 3600_000))).started).toBe(false);
    });
  });
});
