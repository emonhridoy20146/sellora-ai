import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/infra/queue/queue.constants.js';
import { StorageDriver } from '../../src/infra/storage/storage.driver.js';
import { BackupsService } from '../../src/modules/backups/backups.service.js';
import { DRIVE_SCOPE } from '../../src/modules/backups/google-drive.js';
import { MerchantBackupsService } from '../../src/modules/backups/merchant-backups.service.js';
import { FakeGoogle, GOOGLE_TEST, googleEnv } from '../helpers/fake-google.js';
import { TestApp, type Session } from '../helpers/test-app.js';

const BACKUP_KEYS = `b1:${randomBytes(32).toString('base64')}`;

/** Reads a ZIP with Python's zipfile (an independent reader): names and contents. */
function unzip(file: string): Record<string, string> {
  const script = [
    'import json, sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'bad = z.testzip()',
    'assert bad is None, bad',
    'print(json.dumps({n: z.read(n).decode("utf-8") for n in z.namelist()}))',
  ].join('\n');
  return JSON.parse(
    execFileSync('python3', ['-I', '-c', script, file], { maxBuffer: 64 * 1024 * 1024 }).toString(),
  ) as Record<string, string>;
}

/** Every key anywhere in a parsed JSON value. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  return out;
}

describe('merchant backups (ADR 0021)', () => {
  let t: TestApp;
  let google: FakeGoogle;
  let svc: MerchantBackupsService;
  let platform: BackupsService;
  let queue: Queue;
  let dir: string;
  let owner: { token: string };
  let a: Session;
  let b: Session;
  let manager: Session;
  let orgA: { id: string; name: string };
  let orgB: { id: string; name: string };
  const productsA: { id: string; name: string }[] = [];

  const A = () => t.as(a.token);
  const B = () => t.as(b.token);
  const P = () => t.as(owner.token);
  const url = (org: string, path = '') => `/v1/orgs/${org}/backups${path}`;
  const audit = (orgId: string, action: string) =>
    t.db
      .db!.collection('audit_events')
      .find({ orgId: new Types.ObjectId(orgId), action })
      .toArray();
  const setModules = (orgId: string, removeModules: string[]) =>
    P()
      .put(`/v1/platform/billing/tenants/${orgId}/subscription/overrides`)
      .send({ note: 'backup test', removeModules })
      .expect(200);

  const product = async (as: () => ReturnType<TestApp['as']>, org: string, name: string) =>
    (
      await as()
        .post(`/v1/orgs/${org}/products`)
        .send({
          name,
          variants: [{ priceMinor: 125_050, stock: 5, sku: `SKU-${name.slice(0, 3)}` }],
        })
        .expect(201)
    ).body as { id: string; name: string };

  /** Downloads a file the API links to, into the test's folder. */
  const download = async (link: string, as = 'x.zip') => {
    const res = await t
      .http()
      .get(new URL(link).pathname)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const file = join(dir, as);
    if (res.status === 200) await writeFile(file, res.body as Buffer);
    return { res, file };
  };

  /** "Connect Google Drive" end to end: the consent page, then Google's redirect back. */
  const connect = async (as: () => ReturnType<TestApp['as']>, org: string, code: string) => {
    const res = await as().post(url(org, '/drive/connect')).expect(200);
    const consent = new URL(res.body.url as string);
    const back = await t
      .http()
      .get('/v1/backups/google/callback')
      .query({ state: consent.searchParams.get('state'), code, scope: DRIVE_SCOPE })
      .expect(302);
    return { consent, location: back.headers.location as string };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'merchant-backups-'));
    google = new FakeGoogle();
    t = await TestApp.create(
      {
        BACKUP_ENCRYPTION_KEYS: BACKUP_KEYS,
        BACKUP_ENCRYPTION_ACTIVE_KID: 'b1',
        BACKUP_TMP_DIR: join(dir, 'tmp'),
        ...googleEnv,
      },
      { googleFetch: google.fetch },
    );
    svc = t.app.get(MerchantBackupsService);
    platform = t.app.get(BackupsService);
    queue = t.app.get<Queue>(getQueueToken(QUEUES.backups));
    owner = await t.platformOwner();
    a = await t.registerUser({ name: 'Owner A' });
    b = await t.registerUser({ name: 'Owner B' });
    orgA = { id: (await t.createOrg(a, { name: 'Shop Alpha' })).id, name: 'Shop Alpha' };
    orgB = { id: (await t.createOrg(b, { name: 'Shop Beta' })).id, name: 'Shop Beta' };
    manager = await t.addMember(a, orgA.id, 'manager');
    productsA.push(
      await product(A, orgA.id, 'Jamdani saree'),
      await product(A, orgA.id, '=HYPERLINK("http://evil.test")'),
    );
    await A()
      .post(`/v1/orgs/${orgA.id}/customers`)
      .send({ name: 'Rahima Begum', phone: '01711000001' })
      .expect(201);
    await product(B, orgB.id, 'Beta lamp');
    await B()
      .post(`/v1/orgs/${orgB.id}/customers`)
      .send({ name: 'Beta buyer', phone: '01811000001' })
      .expect(201);
  }, 90_000);

  afterAll(async () => {
    await t?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('is for owners and admins only, and never shows another business', async () => {
    await t.as(manager.token).get(url(orgA.id)).expect(403);
    // Not a member: the business is not found at all.
    await B().get(url(orgA.id)).expect(404);
    const res = await A().get(url(orgA.id)).expect(200);
    expect(res.body).toMatchObject({
      exports: [],
      drive: null,
      driveModule: true,
      driveConfigured: true,
      restores: [],
    });
    expect(res.body.parts.map((p: { part: string }) => p.part)).toContain('products');
  });

  describe('download your data', () => {
    let exportId: string;
    let files: Record<string, string>;

    it('prepares one ZIP at a time and keeps it 7 days', async () => {
      const res = await A().post(url(orgA.id, '/exports')).expect(202);
      expect(res.body).toMatchObject({ status: 'running', requestedBy: a.email });
      exportId = res.body.id;
      const again = await A().post(url(orgA.id, '/exports')).expect(409);
      expect(again.body.code).toBe('export_running');
      expect(await queue.getJob(`export-${exportId}`)).toBeTruthy();

      const done = await svc.runExport(exportId);
      expect(done.status).toBe('ready');
      expect(done.size).toBeGreaterThan(500);
      const days = (new Date(done.expiresAt!).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
      const overview = await A().get(url(orgA.id)).expect(200);
      expect(overview.body.exports[0]).toMatchObject({ id: exportId, status: 'ready' });
      expect((await audit(orgA.id, 'backup.export_requested')).length).toBe(1);
    });

    it('downloads through a 10-minute link, with only this business in it and no secrets', async () => {
      const link = await A()
        .post(url(orgA.id, `/exports/${exportId}/link`))
        .expect(200);
      const left = (new Date(link.body.expiresAt as string).getTime() - Date.now()) / 1000;
      expect(left).toBeGreaterThan(590);
      expect(left).toBeLessThanOrEqual(600);
      const { res, file } = await download(link.body.url as string, 'a.zip');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="sellora-shop-alpha[a-z0-9-]*-data-\d{4}-\d{2}-\d{2}\.zip"$/,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      files = unzip(file);
      expect(Object.keys(files)).toEqual(
        expect.arrayContaining([
          'products.csv',
          'customers.csv',
          'orders.csv',
          'README.txt',
          'data/products.json',
          'data/business.json',
          'data/activity_log.json',
        ]),
      );
      // The spreadsheet files: amounts in taka, the formula-looking name made harmless.
      const rows = files['products.csv']!.trim().split('\r\n');
      expect(rows[0]).toMatch(/^product_id,name,status,variant,sku,price,/);
      expect(files['products.csv']).toContain('Jamdani saree');
      expect(files['products.csv']).toContain('1250.50');
      expect(files['products.csv']).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
      expect(files['customers.csv']).toContain('Rahima Begum');

      // Only A: B's records are nowhere in the ZIP.
      const all = Object.values(files).join('\n');
      expect(all).not.toContain('Beta lamp');
      expect(all).not.toContain('Beta buyer');
      expect(all).not.toContain(orgB.id);
      const products = JSON.parse(files['data/products.json']!) as { _id: string; orgId: string }[];
      expect(products.map((p) => p._id).sort()).toEqual(productsA.map((p) => p.id).sort());
      expect(new Set(products.map((p) => p.orgId))).toEqual(new Set([orgA.id]));
      expect(JSON.parse(files['data/business.json']!)).toMatchObject({
        _id: orgA.id,
        name: orgA.name,
      });

      // No secrets or hashes in any file.
      for (const [name, body] of Object.entries(files)) {
        if (!name.endsWith('.json')) continue;
        const keys = [...keysOf(JSON.parse(body))];
        expect(
          keys.filter((k) => /(Enc|Hash)$|^(token|password|secret|__v)$/.test(k)),
          name,
        ).toEqual([]);
      }
      expect(Object.keys(files)).not.toContain('data/ai_usage.json');
      expect(files['README.txt']).toContain('Shop Alpha');
      expect(files['README.txt']).toMatch(/products\s+2\n/);
      expect((await audit(orgA.id, 'backup.export_downloaded')).length).toBe(1);
    });

    it('refuses links for another business and tampered links', async () => {
      // B asking for A's download through B's own business.
      await B()
        .post(url(orgB.id, `/exports/${exportId}/link`))
        .expect(404);
      const link = await A()
        .post(url(orgA.id, `/exports/${exportId}/link`))
        .expect(200);
      const token = new URL(link.body.url as string).pathname.split('/').pop()!;
      const bad = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
      expect((await download(`http://x/v1/backups/exports/${bad}`)).res.status).toBe(404);
    });

    it('removes downloads after 7 days', async () => {
      const storage = t.app.get(StorageDriver);
      const record = await t.db
        .db!.collection('backup_exports')
        .findOne({ _id: new Types.ObjectId(exportId) });
      expect(await storage.head(record!.key as string)).toBeTruthy();
      expect(await svc.expireExports(new Date(Date.now() + 8 * 86_400_000))).toBe(1);
      expect(await storage.head(record!.key as string)).toBeNull();
      const res = await A()
        .post(url(orgA.id, `/exports/${exportId}/link`))
        .expect(409);
      expect(res.body.code).toBe('export_not_ready');
      const overview = await A().get(url(orgA.id)).expect(200);
      expect(overview.body.exports[0]).toMatchObject({ id: exportId, status: 'expired' });
    });
  });

  describe('restore points and the owner restore', () => {
    let pointId: string;
    let restoreId: string;

    it('makes a restore point, shown as the business made it', async () => {
      const res = await A().post(url(orgA.id, '/restore-points')).expect(202);
      expect(res.body).toMatchObject({ scope: 'tenant', reason: 'merchant', status: 'running' });
      pointId = res.body.id;
      const making = await A().get(url(orgA.id)).expect(200);
      expect(making.body.points[0]).toMatchObject({
        id: pointId,
        kind: 'restore_point',
        status: 'making',
      });
      expect((await platform.runQueued(pointId)).status).toBe('verified');
      const ready = await A().get(url(orgA.id)).expect(200);
      expect(ready.body.points[0]).toEqual({
        id: pointId,
        kind: 'restore_point',
        status: 'ready',
        startedAt: expect.any(String),
        verifiedAt: expect.any(String),
        by: a.email,
      });
      // Nothing about other businesses or the platform's files.
      expect(Object.keys(ready.body.points[0])).not.toContain('counts');
      // B does not see A's restore point.
      const other = await B().get(url(orgB.id)).expect(200);
      expect(other.body.points.map((p: { id: string }) => p.id)).not.toContain(pointId);
      expect((await audit(orgA.id, 'backup.restore_point_made')).length).toBe(1);
    });

    it("restores after the person's password, and never from another business's backup", async () => {
      await A().delete(`/v1/orgs/${orgA.id}/products/${productsA[0]!.id}`).expect(200);
      const preview = await A().post(url(orgA.id, '/preview')).send({ runId: pointId }).expect(200);
      const products = preview.body.parts.find((p: { part: string }) => p.part === 'products');
      expect(
        products.collections.find((c: { collection: string }) => c.collection === 'products'),
      ).toMatchObject({ inBackup: 2, now: 1, added: 1, removed: 0 });
      // Not the backup file's details (sizes, counts of every business, who made it).
      expect(Object.keys(preview.body.run).sort()).toEqual(['id', 'startedAt']);

      const body = {
        runId: pointId,
        parts: ['products'],
        reason: 'Deleted a product by mistake',
        confirmName: orgA.name,
        password: 'not my password',
      };
      const wrong = await A().post(url(orgA.id, '/restores')).send(body).expect(422);
      expect(wrong.body.errors[0].path).toBe('password');
      expect((await audit(orgA.id, 'backup.restore_password_failed')).length).toBe(1);
      const name = await A()
        .post(url(orgA.id, '/restores'))
        .send({ ...body, password: 'correct horse battery staple', confirmName: 'Shop' })
        .expect(422);
      expect(name.body.errors[0].path).toBe('confirmName');
      await t.as(manager.token).post(url(orgA.id, '/restores')).send(body).expect(403);

      // B's own restore point cannot be used on B's side for A, or by A.
      const bPoint = await B().post(url(orgB.id, '/restore-points')).expect(202);
      await platform.runQueued(bPoint.body.id as string);
      const cross = await A()
        .post(url(orgA.id, '/restores'))
        .send({ ...body, runId: bPoint.body.id, password: 'correct horse battery staple' })
        .expect(409);
      expect(cross.body.code).toBe('backup_other_business');
      await A().post(url(orgA.id, '/preview')).send({ runId: bPoint.body.id }).expect(409);

      const ok = await A()
        .post(url(orgA.id, '/restores'))
        .send({ ...body, password: 'correct horse battery staple' })
        .expect(202);
      restoreId = ok.body.id;
      const done = await platform.runRestore(restoreId);
      expect(done).toMatchObject({ status: 'done', parts: ['products'] });
      const back = await t.db
        .db!.collection('products')
        .findOne({ _id: new Types.ObjectId(productsA[0]!.id) });
      expect(back?.name).toBe('Jamdani saree');
      expect(
        await t.db
          .db!.collection('products')
          .countDocuments({ orgId: new Types.ObjectId(orgB.id) }),
      ).toBe(1);

      const overview = await A().get(url(orgA.id)).expect(200);
      expect(overview.body.restores[0]).toMatchObject({
        id: restoreId,
        status: 'done',
        by: { type: 'user', label: a.email },
      });
      const restored = await t.db
        .db!.collection('audit_events')
        .findOne({ action: 'backup.restored', orgId: new Types.ObjectId(orgA.id) });
      expect(restored).toBeTruthy();
      const mail = (await t.outbox(a.email)).find(
        (m) => m.category === 'security' && /restored/i.test(m.subject),
      );
      expect(mail?.text).toContain(a.email);
    });

    it('keeps the newest 3 restore points', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await A().post(url(orgA.id, '/restore-points')).expect(202);
        await platform.runQueued(res.body.id as string);
      }
      const runs = await t.db
        .db!.collection('backup_runs')
        .find({ orgId: new Types.ObjectId(orgA.id), reason: 'merchant' })
        .sort({ startedAt: 1 })
        .toArray();
      expect(runs.map((r) => r.status as string)).toEqual([
        'deleted',
        'verified',
        'verified',
        'verified',
      ]);
      expect(String(runs[0]!._id)).toBe(pointId);
    });
  });

  describe('Google Drive', () => {
    let folderId: string;

    it('needs the Drive module in the plan', async () => {
      await setModules(orgA.id, ['backups_drive']);
      const res = await A().post(url(orgA.id, '/drive/connect')).expect(402);
      expect(res.body.code).toBe('module_not_in_plan');
      expect((await A().get(url(orgA.id)).expect(200)).body.driveModule).toBe(false);
      await setModules(orgA.id, []);
    });

    it('asks Google only for the files Sellora makes, with a single-use state', async () => {
      const res = await A().post(url(orgA.id, '/drive/connect')).expect(200);
      const consent = new URL(res.body.url as string);
      expect(`${consent.origin}${consent.pathname}`).toBe(GOOGLE_TEST.auth);
      expect(Object.fromEntries(consent.searchParams)).toMatchObject({
        client_id: GOOGLE_TEST.clientId,
        redirect_uri: 'http://localhost:4000/v1/backups/google/callback',
        response_type: 'code',
        scope: DRIVE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        login_hint: a.email,
      });
      const state = consent.searchParams.get('state')!;
      // The merchant said no on Google's page.
      const denied = await t
        .http()
        .get('/v1/backups/google/callback')
        .query({ state, error: 'access_denied' })
        .expect(302);
      expect(denied.headers.location).toBe(
        `http://localhost:3000/app/${orgA.id}/settings/backups?drive=denied`,
      );
      // The same state does not work twice, and a made-up one never does.
      const reused = await t
        .http()
        .get('/v1/backups/google/callback')
        .query({ state, code: google.issueCode() })
        .expect(302);
      expect(reused.headers.location).toBe('http://localhost:3000/app?drive=expired');
      const forged = await t
        .http()
        .get('/v1/backups/google/callback')
        .query({ state: 'x.y', code: google.issueCode() })
        .expect(302);
      expect(forged.headers.location).toBe('http://localhost:3000/app?drive=expired');
      expect(await t.db.db!.collection('drive_connections').countDocuments({})).toBe(0);
    });

    it('turns away a sign-in without Drive access and revokes it', async () => {
      const before = google.revoked.length;
      const { location } = await connect(
        A,
        orgA.id,
        google.issueCode('merchant@gmail.test', 'openid email'),
      );
      expect(location).toMatch(/drive=no_permission$/);
      expect(google.revoked.length).toBe(before + 1);
      expect(await t.db.db!.collection('drive_connections').countDocuments({})).toBe(0);
    });

    it('connects, keeps the token encrypted, and saves the first copy at once', async () => {
      const { location } = await connect(A, orgA.id, google.issueCode('alpha.owner@gmail.test'));
      expect(location).toBe(
        `http://localhost:3000/app/${orgA.id}/settings/backups?drive=connected`,
      );
      const row = await t.db
        .db!.collection('drive_connections')
        .findOne({ orgId: new Types.ObjectId(orgA.id) });
      expect(row).toMatchObject({
        status: 'connected',
        email: 'alpha.owner@gmail.test',
        enabled: true,
        keep: 7,
      });
      const raw = [...google.refresh.keys()].at(-1)!;
      expect(JSON.stringify(row)).not.toContain(raw);
      expect(row!.refreshTokenEnc).toMatch(/^v1\.k1\./);
      folderId = row!.folderId as string;
      expect(google.files.get(folderId)?.name).toBe('Sellora backups - Shop Alpha');
      const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
      expect(
        jobs.some(
          (j) => j.name === 'drive-copy' && (j.data as { orgId: string }).orgId === orgA.id,
        ),
      ).toBe(true);

      const drive = await svc.runDriveCopy(orgA.id);
      expect(drive).toMatchObject({ status: 'connected', lastError: null, copying: false });
      const [copy] = google.folder(folderId);
      expect(copy!.name).toMatch(/^sellora-shop-alpha[a-z0-9-]*-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
      expect(copy!.mimeType).toBe('application/zip');
      await writeFile(join(dir, 'drive.zip'), copy!.bytes);
      const files = unzip(join(dir, 'drive.zip'));
      expect(files['products.csv']).toContain('Jamdani saree');
      expect(Object.values(files).join('\n')).not.toContain('Beta lamp');

      const overview = await A().get(url(orgA.id)).expect(200);
      expect(overview.body.drive).toMatchObject({
        status: 'connected',
        email: 'alpha.owner@gmail.test',
        folderName: 'Sellora backups - Shop Alpha',
        lastFile: { name: copy!.name, size: copy!.bytes.length },
        connectedBy: a.email,
      });
      expect(Object.keys(overview.body.drive)).not.toContain('refreshTokenEnc');
      // B sees nothing of A's Drive.
      expect((await B().get(url(orgB.id)).expect(200)).body.drive).toBeNull();
      expect((await audit(orgA.id, 'backup.drive_connected')).length).toBe(1);
    });

    it("keeps only the newest copies, and never touches the merchant's own files", async () => {
      await t.as(manager.token).patch(url(orgA.id, '/drive')).send({ keep: 2 }).expect(403);
      await A().patch(url(orgA.id, '/drive')).send({ keep: 0 }).expect(422);
      expect(
        (await A().patch(url(orgA.id, '/drive')).send({ keep: 2 }).expect(200)).body.keep,
      ).toBe(2);
      const notes = google.addOwnFile(folderId, 'my-notes.txt');
      await svc.runDriveCopy(orgA.id);
      await svc.runDriveCopy(orgA.id);
      const left = google.folder(folderId);
      expect(left.filter((f) => f.name.startsWith('sellora-'))).toHaveLength(2);
      expect(left.map((f) => f.id)).toContain(notes.id);
    });

    it('makes the folder again when the merchant deleted it', async () => {
      google.files.delete(folderId);
      const drive = await svc.runDriveCopy(orgA.id);
      expect(drive?.lastError).toBeNull();
      const row = await t.db
        .db!.collection('drive_connections')
        .findOne({ orgId: new Types.ObjectId(orgA.id) });
      expect(row!.folderId).not.toBe(folderId);
      folderId = row!.folderId as string;
      expect(google.folder(folderId)).toHaveLength(1);
    });

    it('records a full Drive and tries again later', async () => {
      // As if today's nightly copy is still to come (yesterday's was the last).
      await t.db
        .db!.collection('drive_connections')
        .updateOne(
          { orgId: new Types.ObjectId(orgA.id) },
          { $set: { lastSuccessAt: new Date(Date.now() - 2 * 86_400_000) } },
        );
      google.failNextUpload = {
        status: 403,
        reason: 'storageQuotaExceeded',
        message: "The user's Drive storage quota has been exceeded.",
      };
      const drive = await svc.runDriveCopy(orgA.id);
      expect(drive).toMatchObject({ status: 'connected', lastError: 'The Google Drive is full' });
      const row = await t.db
        .db!.collection('drive_connections')
        .findOne({ orgId: new Types.ObjectId(orgA.id) });
      expect(row!.failures.count).toBe(1);
      // The sweep waits 30 minutes before the next try, then queues it once.
      const now = new Date();
      expect(await svc.driveSweep(now)).toBe(0);
      const later = new Date(now.getTime() + 31 * 60_000);
      expect(await svc.driveSweep(later)).toBe(1);
      expect(await svc.driveSweep(later)).toBe(0);
      expect((await svc.runDriveCopy(orgA.id, later))?.lastError).toBeNull();
    });

    it('asks the owner to reconnect, once, when Google removed the access', async () => {
      google.revokeAll();
      const drive = await svc.runDriveCopy(orgA.id);
      expect(drive?.status).toBe('reconnect');
      expect(drive?.lastError).toMatch(/removed or has expired/);
      const mails = (await t.outbox(a.email)).filter((m) =>
        /reconnect Google Drive/.test(m.subject),
      );
      expect(mails).toHaveLength(1);
      expect(mails[0]!.text).toContain(`/app/${orgA.id}/settings/backups`);
      // No more tries until it is connected again, and no second email.
      expect(await svc.runDriveCopy(orgA.id)).toBeNull();
      const res = await A().post(url(orgA.id, '/drive/copy')).expect(409);
      expect(res.body.code).toBe('drive_reconnect');
      expect(
        (await t.outbox(a.email)).filter((m) => /reconnect Google Drive/.test(m.subject)),
      ).toHaveLength(1);

      const { location } = await connect(A, orgA.id, google.issueCode('alpha.owner@gmail.test'));
      expect(location).toMatch(/drive=connected$/);
      const row = await t.db
        .db!.collection('drive_connections')
        .findOne({ orgId: new Types.ObjectId(orgA.id) });
      expect(row).toMatchObject({ status: 'connected' });
      expect(row!.lastError).toBeUndefined();
      expect((await svc.runDriveCopy(orgA.id))?.lastError).toBeNull();
    });

    it('stops copying when the plan no longer has the module', async () => {
      await setModules(orgA.id, ['backups_drive']);
      const drive = await svc.runDriveCopy(orgA.id);
      expect(drive?.lastError).toBe('Your plan no longer includes Google Drive backup');
      await setModules(orgA.id, []);
    });

    it('disconnects and revokes the access at Google', async () => {
      const row = await t.db
        .db!.collection('drive_connections')
        .findOne({ orgId: new Types.ObjectId(orgA.id) });
      const live = [...google.refresh.entries()].filter(([, r]) => !r.revoked);
      expect(live).toHaveLength(1);
      await B().delete(url(orgA.id, '/drive')).expect(404);
      await t.as(manager.token).delete(url(orgA.id, '/drive')).expect(403);
      await A().delete(url(orgA.id, '/drive')).expect(204);
      expect(google.refresh.get(live[0]![0])?.revoked).toBe(true);
      expect(await t.db.db!.collection('drive_connections').countDocuments({ _id: row!._id })).toBe(
        0,
      );
      expect((await audit(orgA.id, 'backup.drive_disconnected')).length).toBe(1);
      // The copies already in the Drive are the merchant's to keep.
      expect(google.folder(folderId).length).toBeGreaterThan(0);
    });
  });
});
