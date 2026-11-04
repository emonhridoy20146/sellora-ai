import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Types, type Connection, type Model, type mongo } from 'mongoose';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { MailService } from '../../infra/mail/mail.service.js';
import { mailTemplates } from '../../infra/mail/templates.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import { UrlSigner } from '../../infra/storage/signing.js';
import { StorageDriver } from '../../infra/storage/storage.driver.js';
import { AuditService } from '../audit/audit.service.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { UsersService } from '../users/users.service.js';
import {
  BackupFormatError,
  documentLine,
  hasher,
  readBackup,
  writeBackup,
  type BackupManifest,
  type CollectionInfo,
} from './backup-format.js';
import { BackupKeys, OffsiteStorage } from './backup-keys.js';
import { loadInto } from './backup-load.js';
import {
  DEFAULT_BACKUP_SETTINGS,
  diffIds,
  nightlyDue,
  planRetention,
  RECORD_KEEP_MS,
  RESTORE_LEASE_MS,
  RESTORE_PART_KEYS,
  RESTORE_PARTS,
  RUN_LEASE_MS,
  SAFETY_KEEP_MS,
  scheduledSlot,
  tiersFor,
  type RestorePart,
} from './backup-rules.js';
import type {
  Actor,
  BackupRestore,
  BackupRestoreDoc,
  BackupRun,
  BackupRunDoc,
  BackupSettings,
  RunReason,
} from './schemas.js';

const SETTINGS_ID = 'global';
const BATCH = 500;
/** Collections a business's backup leaves out: they describe backups, not the business. */
const NEVER_IN_TENANT = new Set(['backup_runs', 'backup_restores']);
const CONTENT_TYPE = 'application/vnd.sellora.backup';
/** Lines between lease renewals while a backup is written or read back. */
const RENEW_EVERY = 20_000;
/** A download link works once, for this long. */
const DOWNLOAD_LINK_SECONDS = 300;

/** Jobs on the backups queue. The sweep is the worker's own schedule. */
export const BACKUP_JOBS = {
  sweep: 'sweep',
  write: 'write',
  testRestore: 'test-restore',
  restore: 'restore',
} as const;

type Doc = Record<string, unknown> & { _id?: unknown };

export interface RunDto {
  id: string;
  scope: 'platform' | 'tenant';
  orgId: string | null;
  reason: RunReason;
  status: BackupRun['status'];
  tiers: BackupRun['tiers'];
  size: number | null;
  sha256: string | null;
  docs: number | null;
  counts: Record<string, number>;
  startedAt: string;
  finishedAt: string | null;
  verifiedAt: string | null;
  durationMs: number | null;
  error: string | null;
  testRestore: { at: string; ok: boolean; ms: number; error: string | null } | null;
  testRestorePending: boolean;
  offsite: { at: string; ok: boolean; error: string | null } | null;
  startedBy: Actor | null;
}

/**
 * Backups (ADR 0020): writes, verifies, keeps and removes backup files, test-restores them into
 * a temporary database, and restores chosen parts of one business. Uses the database driver
 * directly (not the tenant-guarded models), so every business query below names its orgId.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('BackupRun') private readonly runs: Model<BackupRun>,
    @InjectModel('BackupSettings') private readonly settingsModel: Model<BackupSettings>,
    @InjectModel('BackupRestore') private readonly restores: Model<BackupRestore>,
    private readonly storage: StorageDriver,
    private readonly keys: BackupKeys,
    private readonly offsite: OffsiteStorage,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly orgs: OrgsService,
    private readonly users: UsersService,
    private readonly config: AppConfig,
    @InjectQueue(QUEUES.backups) private readonly queue: Queue,
    private readonly signer: UrlSigner,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private get db(): mongo.Db {
    return this.connection.db!;
  }

  // ---------------------------------------------------------------- settings

  async settings(): Promise<BackupSettings> {
    const doc = await this.settingsModel
      .findOneAndUpdate(
        { _id: SETTINGS_ID },
        {
          $setOnInsert: {
            enabled: DEFAULT_BACKUP_SETTINGS.enabled,
            hour: DEFAULT_BACKUP_SETTINGS.hour,
            timezone: DEFAULT_BACKUP_SETTINGS.timezone,
            keep: { ...DEFAULT_BACKUP_SETTINGS.keep },
          },
        },
        { upsert: true, returnDocument: 'after' },
      )
      .lean<BackupSettings>()
      .exec();
    return doc;
  }

  async updateSettings(
    patch: Partial<Pick<BackupSettings, 'enabled' | 'hour' | 'timezone' | 'keep'>>,
  ): Promise<BackupSettings> {
    if (patch.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone });
      } catch {
        throw AppError.validation([{ path: 'timezone', message: 'Not a time zone' }]);
      }
    }
    const before = await this.settings();
    const set: Record<string, unknown> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.hour !== undefined) set.hour = patch.hour;
    if (patch.timezone) set.timezone = patch.timezone;
    if (patch.keep) set.keep = { ...before.keep, ...patch.keep };
    const after = (await this.settingsModel
      .findOneAndUpdate({ _id: SETTINGS_ID }, { $set: set }, { returnDocument: 'after' })
      .lean<BackupSettings>()
      .exec())!;
    await this.audit.record({
      action: 'platform.backups.settings_updated',
      target: { type: 'backup_settings', id: SETTINGS_ID, label: 'Backups' },
      metadata: set,
    });
    return after;
  }

  // ---------------------------------------------------------------- the sweep

  /**
   * The worker's sweep (every 5 minutes): marks interrupted runs failed, starts the nightly
   * backup when due, and removes expired safety backups.
   */
  async sweep(
    now = new Date(),
  ): Promise<{ interrupted: number; started: boolean; expired: number }> {
    const interrupted = (await this.recoverInterrupted(now)) + (await this.recoverRestores(now));
    const s = await this.settings();
    let started = false;
    if (s.enabled) {
      const slot = scheduledSlot(now, s.hour, s.timezone);
      const since = await this.runs
        .find(
          { scope: 'platform', reason: 'scheduled', startedAt: { $gte: slot } },
          { startedAt: 1, status: 1 },
        )
        .lean<Pick<BackupRunDoc, 'startedAt' | 'status'>[]>()
        .exec();
      if (nightlyDue(now, since)) {
        started = true;
        await this.backUpPlatform('scheduled', { type: 'system', id: 'system' }, now).catch(
          (err: unknown) => {
            // Already recorded on the run; another worker holding the lock is not a failure.
            if (!(err instanceof AppError && err.code === 'backup_running'))
              this.logger.error({ err }, 'Nightly backup failed');
          },
        );
      }
    }
    const expired = await this.removeExpiredSafety(now);
    return { interrupted, started, expired };
  }

  private async recoverInterrupted(now: Date): Promise<number> {
    const stuck = await this.runs
      .find({ status: { $in: ['running', 'verifying'] }, leaseUntil: { $lt: now } })
      .lean<BackupRunDoc[]>()
      .exec();
    for (const r of stuck) {
      if (r.key) await this.storage.delete(r.key).catch(() => undefined);
      await this.runs.updateOne(
        { _id: r._id, status: r.status },
        {
          $set: {
            status: 'failed',
            finishedAt: now,
            error: 'Interrupted: the server stopped while the backup was being made.',
          },
          $unset: { lockKey: 1, leaseUntil: 1 },
        },
      );
    }
    return stuck.length;
  }

  /** A restore whose worker stopped: unlocks the business and says where its data went. */
  private async recoverRestores(now: Date): Promise<number> {
    const stuck = await this.restores
      .find({ status: 'running', startedAt: { $lt: new Date(now.getTime() - RESTORE_LEASE_MS) } })
      .lean<BackupRestoreDoc[]>()
      .exec();
    for (const r of stuck)
      await this.restores.updateOne(
        { _id: r._id, status: 'running' },
        {
          $set: {
            status: 'failed',
            finishedAt: now,
            error: r.safetyRunId
              ? 'Interrupted: the server stopped part way. The business as it was before is in the safety backup; restore from it to undo.'
              : 'Interrupted: the server stopped before anything was changed.',
          },
          $unset: { lockKey: 1 },
        },
      );
    return stuck.length;
  }

  // ---------------------------------------------------------------- making backups

  /**
   * Starts a backup now (a super-admin's "Back up now", or of one business): the run is
   * recorded at once, so a second request gets a conflict, and the worker makes the file.
   */
  async request(p: { orgId?: string; by: Actor }): Promise<RunDto> {
    const orgId = p.orgId ? (await this.orgs.get(p.orgId))._id : undefined;
    const run = await this.start({
      scope: orgId ? 'tenant' : 'platform',
      ...(orgId ? { orgId } : {}),
      reason: 'manual',
      by: p.by,
      now: new Date(),
    });
    const id = run._id.toHexString();
    await this.queue.add(BACKUP_JOBS.write, { runId: id }, { jobId: `write-${id}`, attempts: 1 });
    await this.audit.record({
      ...(orgId ? { orgId: orgId.toHexString() } : {}),
      action: 'platform.backups.started',
      target: { type: 'backup', id, label: orgId ? 'Business backup' : 'Platform backup' },
      metadata: { scope: run.scope },
    });
    return toDto(run);
  }

  /** The worker's side of `request`: makes the file of a run that is still running. */
  async runQueued(runId: string): Promise<RunDto> {
    const run = await this.load(runId);
    if (run.status !== 'running') return toDto(run);
    return this.complete(run, new Date());
  }

  /** Backs up the whole platform, verifies it, applies retention. Returns the finished run. */
  async backUpPlatform(reason: 'scheduled' | 'manual', by: Actor, now = new Date()) {
    const run = await this.start({ scope: 'platform', reason, by, now });
    return this.complete(run, now);
  }

  /** Writes and verifies the run's file; a platform backup then takes its tiers and copies. */
  private async complete(run: BackupRunDoc, now: Date): Promise<RunDto> {
    const done = await this.write(run, run.scope === 'tenant' ? run.orgId! : null);
    if (run.scope !== 'platform' || done.status !== 'verified') return done;
    const s = await this.settings();
    const verified = await this.runs
      .find(
        { scope: 'platform', status: 'verified', _id: { $ne: run._id } },
        { startedAt: 1, tiers: 1 },
      )
      .lean<Pick<BackupRunDoc, 'startedAt' | 'tiers'>[]>()
      .exec();
    const tiers = tiersFor(run.startedAt, s.timezone, verified);
    await this.runs.updateOne({ _id: run._id }, { $set: { tiers } });
    await this.copyOffsite(run._id);
    await this.applyRetention(now);
    // The weekly copy is the one the plan's weekly test restore checks.
    if (tiers.includes('weekly'))
      await this.testRestore(run._id.toHexString()).catch(() => undefined);
    return this.require(run._id.toHexString());
  }

  /** Backs up one business (a safety copy before a restore, or the merchant's own copy). */
  async backUpTenant(orgId: string, reason: 'safety' | 'merchant' | 'manual', by: Actor) {
    const org = new Types.ObjectId(orgId);
    const run = await this.start({ scope: 'tenant', orgId: org, reason, by, now: new Date() });
    return this.write(run, org);
  }

  private async start(p: {
    scope: 'platform' | 'tenant';
    orgId?: Types.ObjectId;
    reason: RunReason;
    by: Actor;
    now: Date;
  }): Promise<BackupRunDoc> {
    const lockKey = p.scope === 'platform' ? 'platform' : `org:${p.orgId!.toHexString()}`;
    try {
      const created = await this.runs.create({
        scope: p.scope,
        ...(p.orgId ? { orgId: p.orgId } : {}),
        reason: p.reason,
        status: 'running',
        tiers: [],
        startedAt: p.now,
        lockKey,
        leaseUntil: new Date(Date.now() + RUN_LEASE_MS),
        startedBy: p.by,
        ...(p.reason === 'safety'
          ? { expiresAt: new Date(p.now.getTime() + SAFETY_KEEP_MS + RECORD_KEEP_MS) }
          : {}),
      });
      return created.toObject() as unknown as BackupRunDoc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw AppError.conflict(
          'backup_running',
          'A backup is being made right now. Try again in a few minutes.',
        );
      throw err;
    }
  }

  /** The collections in the database with what a restore needs to recreate them. */
  private async collections(scope: 'platform' | 'tenant'): Promise<CollectionInfo[]> {
    const list = await this.db.listCollections({}, { nameOnly: false }).toArray();
    const out: CollectionInfo[] = [];
    for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
      if (c.name.startsWith('system.')) continue;
      if (c.type !== 'collection' && c.type !== 'timeseries') continue;
      // A business's backup reads every collection by its orgId, so collections that hold
      // no business data simply give nothing (whichever models this process has loaded).
      if (scope === 'tenant' && NEVER_IN_TENANT.has(c.name)) continue;
      const options = { ...((c as { options?: Record<string, unknown> }).options ?? {}) };
      const indexes = (await this.db.collection(c.name).indexes()).filter((i) => i.name !== '_id_');
      out.push({ name: c.name, options, indexes: indexes });
    }
    return out;
  }

  /** Writes the run's file, uploads it, and verifies it. Never throws for a backup failure. */
  private async write(run: BackupRunDoc, orgId: Types.ObjectId | null): Promise<RunDto> {
    const id = run._id.toHexString();
    const key = orgId
      ? `backups/orgs/${orgId.toHexString()}/${id}.slbk`
      : `backups/platform/${run.startedAt.toISOString().slice(0, 4)}/${id}.slbk`;
    const dir = this.config.get('BACKUP_TMP_DIR') || tmpdir();
    const temp = join(dir, `sellora-${id}-${randomBytes(4).toString('hex')}.slbk`);
    const counts: Record<string, number> = {};
    let docs = 0;
    const session = this.connection.getClient().startSession({ snapshot: true });
    try {
      await mkdir(dir, { recursive: true });
      const collections = await this.collections(orgId ? 'tenant' : 'platform');
      const manifest: BackupManifest = {
        t: 'm',
        format: 'slbk/1',
        scope: orgId ? 'tenant' : 'platform',
        orgId: orgId?.toHexString() ?? null,
        createdAt: run.startedAt.toISOString(),
        database: this.db.databaseName,
        collections,
      };
      const db = this.db;
      const renew = () =>
        this.runs.updateOne(
          { _id: run._id },
          { $set: { leaseUntil: new Date(Date.now() + RUN_LEASE_MS) } },
        );
      async function* lines(): AsyncGenerator<string> {
        yield `${JSON.stringify(manifest)}\n`;
        for (const c of collections) {
          const filter = !orgId ? {} : c.name === 'organizations' ? { _id: orgId } : { orgId };
          counts[c.name] = 0;
          const cursor = db.collection(c.name).find(filter, { session, batchSize: 1000 });
          for await (const doc of cursor) {
            counts[c.name] = (counts[c.name] ?? 0) + 1;
            docs += 1;
            if (docs % RENEW_EVERY === 0) await renew();
            yield documentLine(c.name, doc);
          }
          if (orgId && counts[c.name] === 0) delete counts[c.name];
        }
        yield `${JSON.stringify({ t: 'e', counts, docs })}\n`;
      }
      const { sha256, size } = await writeBackup(
        lines(),
        createWriteStream(temp),
        this.keys.active,
      );
      await this.storage.putFile(key, temp, CONTENT_TYPE);
      await this.runs.updateOne(
        { _id: run._id },
        {
          $set: {
            status: 'verifying',
            key,
            kid: this.keys.active.kid,
            size,
            sha256,
            counts,
            docs,
            finishedAt: new Date(),
            leaseUntil: new Date(Date.now() + RUN_LEASE_MS),
          },
        },
      );
    } catch (err) {
      await this.storage.delete(key).catch(() => undefined);
      return this.fail(run._id, err);
    } finally {
      await session.endSession().catch(() => undefined);
      await rm(temp, { force: true });
    }
    return this.verify(id);
  }

  private async fail(id: Types.ObjectId, err: unknown): Promise<RunDto> {
    const message = describe(err);
    this.logger.error({ err, runId: id.toHexString() }, 'Backup failed');
    await this.runs.updateOne(
      { _id: id },
      {
        $set: { status: 'failed', error: message, finishedAt: new Date() },
        $unset: { lockKey: 1, leaseUntil: 1 },
      },
    );
    return this.require(id.toHexString());
  }

  /**
   * Reads the stored file back: checksum, size, GCM tag, every line, counts equal to what was
   * written. Only then is the run verified.
   */
  async verify(id: string): Promise<RunDto> {
    const run = await this.load(id);
    let read = 0;
    const renew = async () => {
      read += 1;
      if (read % RENEW_EVERY === 0)
        await this.runs.updateOne(
          { _id: run._id },
          { $set: { leaseUntil: new Date(Date.now() + RUN_LEASE_MS) } },
        );
    };
    try {
      const { counts, manifest } = await this.readAll(run, renew);
      const expected = run.counts ?? {};
      for (const name of new Set([...Object.keys(expected), ...Object.keys(counts)]))
        if ((expected[name] ?? 0) !== (counts[name] ?? 0))
          throw new BackupFormatError(
            `${name}: ${counts[name] ?? 0} documents read back, ${expected[name] ?? 0} written`,
          );
      if (manifest.scope !== run.scope)
        throw new BackupFormatError('The file is of another kind of backup');
      await this.runs.updateOne(
        { _id: run._id },
        {
          $set: { status: 'verified', verifiedAt: new Date() },
          $unset: { lockKey: 1, leaseUntil: 1, error: 1 },
        },
      );
    } catch (err) {
      if (run.key) await this.storage.delete(run.key).catch(() => undefined);
      return this.fail(run._id, err);
    }
    return this.require(id);
  }

  /** Reads a whole stored file, checking its checksum and size; returns its counts. */
  private async readAll(run: BackupRunDoc, each?: (c: string, d: Doc) => void | Promise<void>) {
    const stream = await this.openStored(run);
    const tap = hasher();
    const counts: Record<string, number> = {};
    let manifest: BackupManifest | null = null;
    let end: { counts: Record<string, number> } | null = null;
    for await (const line of readBackup(stream, (k) => this.keys.get(k), tap)) {
      if (line.t === 'm') manifest = line;
      else if (line.t === 'e') end = line;
      else {
        counts[line.c] = (counts[line.c] ?? 0) + 1;
        await each?.(line.c, line.d);
      }
    }
    const { sha256, size } = tap.result();
    if (!manifest || !end) throw new BackupFormatError('The backup file is incomplete');
    if (run.sha256 && sha256 !== run.sha256)
      throw new BackupFormatError('The checksum does not match');
    if (run.size !== undefined && size !== run.size)
      throw new BackupFormatError('The size does not match');
    for (const [name, n] of Object.entries(end.counts))
      if ((counts[name] ?? 0) !== n) throw new BackupFormatError(`${name}: the end line says ${n}`);
    return { counts, manifest };
  }

  private async openStored(run: BackupRunDoc): Promise<Readable> {
    if (!run.key) throw new BackupFormatError('This backup has no file');
    const obj = await this.storage.open(run.key);
    if (!obj) throw new BackupFormatError('The backup file is missing from storage');
    return obj.body;
  }

  private async copyOffsite(id: Types.ObjectId): Promise<void> {
    const driver = this.offsite.driver;
    if (!driver) return;
    const run = await this.load(id.toHexString());
    const dir = this.config.get('BACKUP_TMP_DIR') || tmpdir();
    const temp = join(dir, `sellora-offsite-${id.toHexString()}.slbk`);
    try {
      await pipeline(await this.openStored(run), createWriteStream(temp));
      await driver.putFile(run.key!, temp, CONTENT_TYPE);
      const head = await driver.head(run.key!);
      if (head?.size !== run.size) throw new Error('The off-site copy has another size');
      await this.runs.updateOne({ _id: id }, { $set: { offsite: { at: new Date(), ok: true } } });
    } catch (err) {
      this.logger.error({ err, runId: id.toHexString() }, 'Off-site copy failed');
      await this.runs.updateOne(
        { _id: id },
        { $set: { offsite: { at: new Date(), ok: false, error: describe(err) } } },
      );
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** Keeps the newest verified platform backups per the settings; deletes the other files. */
  async applyRetention(now = new Date()): Promise<number> {
    const s = await this.settings();
    const verified = await this.runs
      .find({ scope: 'platform', status: 'verified' }, { startedAt: 1, tiers: 1, key: 1 })
      .lean<BackupRunDoc[]>()
      .exec();
    const { remove } = planRetention(
      verified.map((r) => ({ ...r, id: r._id.toHexString() })),
      s.keep,
    );
    for (const r of remove) await this.removeFile(r, now);
    return remove.length;
  }

  private async removeFile(r: Pick<BackupRunDoc, '_id' | 'key'>, now: Date): Promise<void> {
    if (r.key) {
      await this.storage.delete(r.key);
      await this.offsite.driver?.delete(r.key).catch(() => undefined);
    }
    await this.runs.updateOne(
      { _id: r._id },
      {
        $set: {
          status: 'deleted',
          deletedAt: now,
          expiresAt: new Date(now.getTime() + RECORD_KEEP_MS),
        },
      },
    );
  }

  private async removeExpiredSafety(now: Date): Promise<number> {
    const old = await this.runs
      .find({
        scope: 'tenant',
        reason: 'safety',
        status: { $in: ['verified', 'failed'] },
        startedAt: { $lt: new Date(now.getTime() - SAFETY_KEEP_MS) },
      })
      .lean<BackupRunDoc[]>()
      .exec();
    for (const r of old) await this.removeFile(r, now);
    return old.length;
  }

  // ---------------------------------------------------------------- test restore

  /**
   * Loads a verified backup into a temporary database on the same server, rebuilds the
   * indexes, compares the counts, and drops the temporary database.
   */
  async requestTestRestore(id: string): Promise<RunDto> {
    const run = await this.load(id);
    if (run.status !== 'verified')
      throw AppError.conflict(
        'backup_not_verified',
        'Only a verified backup can be test-restored.',
      );
    const queued = await this.runs.updateOne(
      { _id: run._id, testRestoreQueuedAt: { $exists: false } },
      { $set: { testRestoreQueuedAt: new Date() } },
    );
    if (queued.modifiedCount === 1)
      await this.queue.add(
        BACKUP_JOBS.testRestore,
        { runId: id },
        { jobId: `test-restore-${id}-${Date.now()}`, attempts: 1 },
      );
    return this.require(id);
  }

  async testRestore(id: string): Promise<RunDto> {
    const run = await this.load(id);
    if (run.status !== 'verified') {
      await this.runs.updateOne({ _id: run._id }, { $unset: { testRestoreQueuedAt: 1 } });
      throw AppError.conflict(
        'backup_not_verified',
        'Only a verified backup can be test-restored.',
      );
    }
    const started = Date.now();
    const target = this.connection
      .getClient()
      .db(`${this.db.databaseName.slice(0, 30)}_rt_${id.slice(-10)}`);
    try {
      await target.dropDatabase();
      const result = await loadInto(target, await this.openStored(run), (k) => this.keys.get(k));
      for (const [name, n] of Object.entries(run.counts ?? {})) {
        const got = await target.collection(name).countDocuments();
        if (got !== n)
          throw new Error(`${name}: ${got} documents after the restore, ${n} in the backup`);
      }
      if (result.docs !== run.docs)
        throw new Error(`${result.docs} documents restored, ${run.docs ?? 0} in the backup`);
      await this.runs.updateOne(
        { _id: run._id },
        {
          $set: { testRestore: { at: new Date(), ok: true, ms: Date.now() - started } },
          $unset: { testRestoreQueuedAt: 1 },
        },
      );
    } catch (err) {
      this.logger.error({ err, runId: id }, 'Test restore failed');
      await this.runs.updateOne(
        { _id: run._id },
        {
          $set: {
            testRestore: {
              at: new Date(),
              ok: false,
              ms: Date.now() - started,
              error: describe(err),
            },
          },
          $unset: { testRestoreQueuedAt: 1 },
        },
      );
    } finally {
      await target.dropDatabase().catch(() => undefined);
    }
    return this.require(id);
  }

  // ---------------------------------------------------------------- reading runs

  async list(q: {
    scope?: 'platform' | 'tenant';
    orgId?: string;
    limit: number;
  }): Promise<RunDto[]> {
    const filter: Record<string, unknown> = {};
    if (q.scope) filter.scope = q.scope;
    if (q.orgId) filter.orgId = new Types.ObjectId(q.orgId);
    const rows = await this.runs
      .find(filter)
      .sort({ startedAt: -1 })
      .limit(q.limit)
      .lean<BackupRunDoc[]>()
      .exec();
    return rows.map(toDto);
  }

  /** Verified backups that hold this business: platform backups and its own. */
  async pointsFor(orgId: string): Promise<RunDto[]> {
    const rows = await this.runs
      .find({
        status: 'verified',
        $or: [{ scope: 'platform' }, { scope: 'tenant', orgId: new Types.ObjectId(orgId) }],
      })
      .sort({ startedAt: -1 })
      .limit(50)
      .lean<BackupRunDoc[]>()
      .exec();
    return rows.map(toDto);
  }

  async require(id: string): Promise<RunDto> {
    return toDto(await this.load(id));
  }

  private async load(id: string): Promise<BackupRunDoc> {
    const run = Types.ObjectId.isValid(id)
      ? await this.runs.findById(id).lean<BackupRunDoc>().exec()
      : null;
    if (!run) throw AppError.notFound('backup');
    return run;
  }

  /**
   * A link to the stored (still encrypted) file of a verified backup, for the super-admin to
   * download: it works once, for five minutes. The caller has checked a fresh 2-step code.
   */
  async downloadLink(
    id: string,
    reason: string,
  ): Promise<{ url: string; expiresAt: string; filename: string }> {
    const run = await this.load(id);
    if (run.status !== 'verified')
      throw AppError.conflict('backup_not_verified', 'Only a verified backup can be downloaded.');
    const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_LINK_SECONDS;
    const token = this.signer.sign({
      p: 'backup',
      r: id,
      j: randomBytes(12).toString('base64url'),
      exp,
    });
    await this.audit.record({
      action: 'platform.backups.downloaded',
      target: { type: 'backup', id, label: run.startedAt.toISOString() },
      metadata: {
        reason,
        scope: run.scope,
        ...(run.orgId ? { orgId: run.orgId.toHexString() } : {}),
        size: run.size,
      },
    });
    const api = this.config.get('API_PUBLIC_URL').replace(/\/+$/, '');
    return {
      url: `${api}/v1/platform/backups/downloads/${token}`,
      expiresAt: new Date(exp * 1000).toISOString(),
      filename: filenameFor(run),
    };
  }

  /** The file behind a download link, once. Anything wrong is "not found". */
  async openDownload(token: string): Promise<{ body: Readable; filename: string; size: number }> {
    const claims = this.signer.verify<{ p?: string; r?: string; j?: string; exp: number }>(token);
    if (claims?.p !== 'backup' || !claims.r || !claims.j) throw AppError.notFound('backup');
    const first = await this.redis.set(
      `backup-dl:${claims.j}`,
      '1',
      'EX',
      DOWNLOAD_LINK_SECONDS * 2,
      'NX',
    );
    if (first !== 'OK') throw AppError.notFound('backup');
    const run = await this.load(claims.r);
    if (run.status !== 'verified') throw AppError.notFound('backup');
    return { body: await this.openStored(run), filename: filenameFor(run), size: run.size ?? 0 };
  }

  // ---------------------------------------------------------------- one business

  /** Which business documents a backup holds, filtered to one business. */
  private async readTenant(
    run: BackupRunDoc,
    orgId: Types.ObjectId,
    collections: Set<string>,
    each: (c: string, d: Doc) => void | Promise<void>,
  ): Promise<void> {
    if (run.scope === 'tenant' && !run.orgId?.equals(orgId))
      throw AppError.conflict('backup_other_business', 'This backup belongs to another business.');
    const stream = await this.openStored(run);
    const hex = orgId.toHexString();
    for await (const line of readBackup(stream, (k) => this.keys.get(k))) {
      if (line.t !== 'd' || !collections.has(line.c)) continue;
      const owner = line.d.orgId;
      // Only an ObjectId equal to this business's id: never a string that happens to match.
      if (
        (owner as { _bsontype?: string } | null)?._bsontype !== 'ObjectId' ||
        String(owner) !== hex
      )
        continue;
      await each(line.c, line.d);
    }
  }

  /** What restoring each part from this backup would add, replace and remove. */
  async preview(orgIdRaw: string, runId: string) {
    const org = await this.orgs.get(orgIdRaw);
    const orgId = org._id;
    const run = await this.load(runId);
    if (run.status !== 'verified')
      throw AppError.conflict('backup_not_verified', 'Choose a verified backup.');
    const all = new Set<string>(RESTORE_PART_KEYS.flatMap((p) => RESTORE_PARTS[p].collections));
    const inBackup = new Map<string, Set<string>>([...all].map((c) => [c, new Set<string>()]));
    await this.readTenant(run, orgId, all, (c, d) => {
      inBackup.get(c)!.add(String(d._id));
    });
    const parts = [];
    for (const part of RESTORE_PART_KEYS) {
      const rows: ({ collection: string } & ReturnType<typeof diffIds>)[] = [];
      for (const name of RESTORE_PARTS[part].collections) {
        const current = new Set(
          (
            await this.db
              .collection(name)
              .find({ orgId }, { projection: { _id: 1 } })
              .toArray()
          ).map((d) => String(d._id)),
        );
        rows.push({ collection: name, ...diffIds(inBackup.get(name)!, current) });
      }
      const sum = (k: 'inBackup' | 'now' | 'added' | 'replaced' | 'removed') =>
        rows.reduce((n, r) => n + r[k], 0);
      parts.push({
        part,
        label: RESTORE_PARTS[part].label,
        inBackup: sum('inBackup'),
        now: sum('now'),
        added: sum('added'),
        replaced: sum('replaced'),
        removed: sum('removed'),
        collections: rows,
      });
    }
    return { run: toDto(run), business: { id: orgId.toHexString(), name: org.name }, parts };
  }

  /**
   * Asks for a restore of chosen parts of one business from a verified backup. Checks what
   * can be checked at once (the name typed, the parts, the backup) and records the restore,
   * which locks the business against a second one; the worker then does it (`runRestore`).
   */
  async requestRestore(
    orgIdRaw: string,
    runId: string,
    input: { parts: RestorePart[]; reason: string; confirmName: string },
    by: Actor,
  ) {
    const org = await this.orgs.get(orgIdRaw);
    const orgId = org._id;
    if (input.confirmName.trim() !== org.name.trim())
      throw AppError.validation([
        { path: 'confirmName', message: `Type the business's name exactly: ${org.name}` },
      ]);
    const parts = [...new Set(input.parts)].filter((p) => RESTORE_PART_KEYS.includes(p));
    if (!parts.length)
      throw AppError.validation([{ path: 'parts', message: 'Choose at least one part' }]);
    const run = await this.load(runId);
    if (run.status !== 'verified')
      throw AppError.conflict('backup_not_verified', 'Choose a verified backup.');
    if (run.scope === 'tenant' && !run.orgId?.equals(orgId))
      throw AppError.conflict('backup_other_business', 'This backup belongs to another business.');

    let record: BackupRestoreDoc;
    try {
      record = (
        await this.restores.create({
          orgId,
          runId: run._id,
          parts,
          status: 'running',
          reason: input.reason,
          by,
          startedAt: new Date(),
          lockKey: `org:${orgId.toHexString()}`,
        })
      ).toObject() as unknown as BackupRestoreDoc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw AppError.conflict('restore_running', 'A restore of this business is already going.');
      throw err;
    }
    const id = record._id.toHexString();
    await this.queue.add(
      BACKUP_JOBS.restore,
      { restoreId: id },
      { jobId: `restore-${id}`, attempts: 1 },
    );
    return this.restoreDto(record);
  }

  /**
   * Does a restore: reads the whole file once (a damaged file stops here, before anything
   * changes), makes and verifies a safety backup of the business, then per collection takes
   * the business's current documents out and puts the backup's in. Never throws.
   */
  async runRestore(restoreId: string) {
    const record = await this.restores.findById(restoreId).lean<BackupRestoreDoc>().exec();
    if (!record) throw AppError.notFound('restore');
    if (record.status !== 'running') return this.restoreDto(record);
    const orgId = record.orgId;
    const parts = record.parts;
    const runId = record.runId.toHexString();
    const restored: Record<string, number> = {};
    const removed: Record<string, number> = {};
    let changed = false;
    let label = orgId.toHexString();
    try {
      const org = await this.orgs.get(orgId.toHexString());
      label = org.name;
      const run = await this.load(runId);
      if (run.status !== 'verified') throw new Error('The backup is no longer available');
      await this.readAll(run);
      const safety = await this.backUpTenant(orgId.toHexString(), 'safety', record.by);
      if (safety.status !== 'verified')
        throw new Error(
          `The safety backup failed (${safety.error ?? 'unknown'}), so nothing was changed`,
        );
      await this.restores.updateOne(
        { _id: record._id },
        { $set: { safetyRunId: new Types.ObjectId(safety.id) } },
      );

      const collections = new Set<string>(parts.flatMap((p) => RESTORE_PARTS[p].collections));
      changed = true;
      for (const name of collections) {
        const r = await this.db.collection(name).deleteMany({ orgId });
        removed[name] = r.deletedCount;
        restored[name] = 0;
      }
      const pending = new Map<string, Doc[]>();
      const flush = async (name: string) => {
        const batch = pending.get(name);
        if (!batch?.length) return;
        await this.db
          .collection(name)
          .insertMany(batch as mongo.OptionalId<mongo.Document>[], { ordered: true });
        restored[name] = (restored[name] ?? 0) + batch.length;
        pending.set(name, []);
      };
      await this.readTenant(run, orgId, collections, async (c, d) => {
        // Belt and braces: a document of another business is never written.
        if (String(d.orgId) !== orgId.toHexString()) return;
        const list = pending.get(c) ?? [];
        list.push(d);
        pending.set(c, list);
        if (list.length >= BATCH) await flush(c);
      });
      for (const name of collections) await flush(name);

      await this.restores.updateOne(
        { _id: record._id },
        {
          $set: { status: 'done', finishedAt: new Date(), restored, removed },
          $unset: { lockKey: 1 },
        },
      );
      const metadata = {
        runId,
        backupAt: run.startedAt.toISOString(),
        parts,
        reason: record.reason,
        safetyRunId: safety.id,
      };
      const target = { type: 'organization', id: orgId.toHexString(), label: org.name };
      const actor = auditActor(record.by);
      await this.audit.record({
        actor,
        action: 'platform.backups.business_restored',
        target,
        metadata,
      });
      await this.audit.record({
        actor,
        orgId: orgId.toHexString(),
        action: 'backup.restored',
        target,
        metadata,
      });
      await this.tellOwner(org, parts, run.startedAt, record.reason);
    } catch (err) {
      this.logger.error({ err, orgId: orgId.toHexString(), runId }, 'Restore failed');
      const error = changed
        ? `${describe(err)}. The business as it was before is in the safety backup; restore from it to undo.`
        : describe(err);
      await this.restores.updateOne(
        { _id: record._id },
        {
          $set: { status: 'failed', finishedAt: new Date(), restored, removed, error },
          $unset: { lockKey: 1 },
        },
      );
      await this.audit.recordSafe({
        actor: auditActor(record.by),
        action: 'platform.backups.business_restored',
        outcome: 'failure',
        target: { type: 'organization', id: orgId.toHexString(), label },
        metadata: { runId, parts, error },
      });
    }
    return this.restoreDto(
      (await this.restores.findById(record._id).lean<BackupRestoreDoc>().exec())!,
    );
  }

  async restoresFor(orgId: string) {
    const rows = await this.restores
      .find({ orgId: new Types.ObjectId(orgId) })
      .sort({ startedAt: -1 })
      .limit(20)
      .lean<BackupRestoreDoc[]>()
      .exec();
    return rows.map((r) => this.restoreDto(r));
  }

  private restoreDto(r: BackupRestoreDoc) {
    return {
      id: r._id.toHexString(),
      orgId: r.orgId.toHexString(),
      runId: r.runId.toHexString(),
      safetyRunId: r.safetyRunId?.toHexString() ?? null,
      parts: r.parts,
      status: r.status,
      reason: r.reason,
      by: r.by,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      restored: r.restored ?? {},
      removed: r.removed ?? {},
      error: r.error ?? null,
    };
  }

  private async tellOwner(
    org: { _id: Types.ObjectId; name: string; ownerUserId: Types.ObjectId; timezone: string },
    parts: RestorePart[],
    at: Date,
    reason: string,
  ) {
    try {
      const [owner] = await this.users.findByIds([org.ownerUserId]);
      if (!owner) return;
      const web = this.config.get('WEB_APP_URL').replace(/\/$/, '');
      await this.mail.send({
        to: owner.email,
        category: 'security',
        ...mailTemplates.dataRestored(owner.locale, {
          businessName: org.name,
          parts: parts.map((p) => RESTORE_PARTS[p].label).join(', '),
          backupAt: new Intl.DateTimeFormat('en-GB', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: org.timezone,
          }).format(at),
          reason,
          url: `${web}/app/${org._id.toHexString()}`,
        }),
      });
    } catch (err) {
      this.logger.error(
        { err, orgId: org._id.toHexString() },
        'Could not email the owner about the restore',
      );
    }
  }
}

/** The person who asked for a restore, for audit records the worker writes. */
function auditActor(by: Actor) {
  return { type: by.type, id: by.id ?? by.type, ...(by.label ? { label: by.label } : {}) };
}

function filenameFor(run: BackupRunDoc): string {
  const stamp = run.startedAt.toISOString().replace(/:/g, '-').slice(0, 19);
  const what = run.scope === 'platform' ? 'platform' : `business-${run.orgId!.toHexString()}`;
  return `sellora-${what}-${stamp}.slbk`;
}

export function describe(err: unknown): string {
  if (err instanceof BackupFormatError) return err.message;
  const code = (err as { codeName?: string }).codeName;
  if (code === 'SnapshotTooOld')
    return 'The backup took longer than MongoDB keeps a snapshot (5 minutes by default). Raise minSnapshotHistoryWindowInSeconds or use physical backups.';
  return err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
}

function toDto(r: BackupRunDoc): RunDto {
  return {
    id: r._id.toHexString(),
    scope: r.scope,
    orgId: r.orgId?.toHexString() ?? null,
    reason: r.reason,
    status: r.status,
    tiers: r.tiers ?? [],
    size: r.size ?? null,
    sha256: r.sha256 ?? null,
    docs: r.docs ?? null,
    counts: r.counts ?? {},
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
    error: r.error ?? null,
    testRestore: r.testRestore?.at
      ? {
          at: r.testRestore.at.toISOString(),
          ok: r.testRestore.ok,
          ms: r.testRestore.ms,
          error: r.testRestore.error ?? null,
        }
      : null,
    testRestorePending: Boolean(r.testRestoreQueuedAt),
    offsite: r.offsite?.at
      ? { at: r.offsite.at.toISOString(), ok: r.offsite.ok, error: r.offsite.error ?? null }
      : null,
    startedBy: r.startedBy ?? null,
  };
}
