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
import { Types, type Connection, type Model, type mongo } from 'mongoose';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import { MailService } from '../../infra/mail/mail.service.js';
import { mailTemplates } from '../../infra/mail/templates.js';
import { QUEUES } from '../../infra/queue/queue.constants.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import { UrlSigner } from '../../infra/storage/signing.js';
import { StorageDriver } from '../../infra/storage/storage.driver.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/core/password.service.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { UsersService } from '../users/users.service.js';
import {
  RESTORE_PART_KEYS,
  RESTORE_PARTS,
  scheduledSlot,
  type RestorePart,
} from './backup-rules.js';
import { BACKUP_JOBS, BackupsService, describe } from './backups.service.js';
import { writeExport } from './export.js';
import { DRIVE_SCOPE, GoogleDriveClient, GoogleError } from './google-drive.js';
import type {
  Actor,
  BackupExport,
  BackupExportDoc,
  DriveConnection,
  DriveConnectionDoc,
} from './schemas.js';

/** Downloads are kept this long, then removed. */
const EXPORT_KEEP_MS = 7 * 24 * 3600_000;
/** A download link works for this long. */
const EXPORT_LINK_SECONDS = 600;
/** The Drive copy runs at this hour in the business's time zone (after the platform's). */
const DRIVE_HOUR = 4;
const DRIVE_RETRY_MS = 30 * 60_000;
const DRIVE_MAX_ATTEMPTS = 3;
const DRIVE_LEASE_MS = 30 * 60_000;
/** Copies queued per sweep (every 5 minutes), so the queue is not flooded at 04:00. */
const DRIVE_PER_SWEEP = 50;
const ZIP = 'application/zip';

export interface ExportDto {
  id: string;
  status: BackupExport['status'];
  size: number | null;
  startedAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  error: string | null;
  requestedBy: string | null;
  downloads: number;
}

export interface DriveDto {
  status: DriveConnection['status'];
  email: string;
  folderName: string;
  enabled: boolean;
  keep: number;
  connectedAt: string;
  connectedBy: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastFile: { name: string; size: number; at: string } | null;
  copying: boolean;
}

/**
 * The business's own side of backups (ADR 0021): "Download your data", restore points, the
 * owner's restore and daily copies to the business's Google Drive.
 */
@Injectable()
export class MerchantBackupsService {
  private readonly logger = new Logger(MerchantBackupsService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('BackupExport') private readonly exports: Model<BackupExport>,
    @InjectModel('DriveConnection') private readonly drives: Model<DriveConnection>,
    private readonly backups: BackupsService,
    private readonly storage: StorageDriver,
    private readonly signer: UrlSigner,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly encryption: EncryptionService,
    private readonly passwords: PasswordService,
    private readonly limits: RateLimitService,
    private readonly users: UsersService,
    private readonly orgs: OrgsService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly google: GoogleDriveClient,
    private readonly config: AppConfig,
    @InjectQueue(QUEUES.backups) private readonly queue: Queue,
  ) {}

  private get db(): mongo.Db {
    return this.connection.db!;
  }

  private tmp(name: string): string {
    return join(
      this.config.get('BACKUP_TMP_DIR') || tmpdir(),
      `${name}-${randomBytes(4).toString('hex')}`,
    );
  }

  private web(): string {
    return this.config.get('WEB_APP_URL').replace(/\/+$/, '');
  }

  // ---------------------------------------------------------------- the page

  async overview(orgId: string) {
    const org = new Types.ObjectId(orgId);
    const [exports, drive, driveModule, points, restores] = await Promise.all([
      this.exports
        .find({ orgId: org })
        .sort({ startedAt: -1 })
        .limit(5)
        .lean<BackupExportDoc[]>()
        .exec(),
      this.drives.findOne({ orgId: org }).lean<DriveConnectionDoc>().exec(),
      this.entitlements.hasModule(orgId, 'backups_drive'),
      this.backups.merchantPoints(orgId),
      this.backups.restoresFor(orgId),
    ]);
    return {
      exports: exports.map(exportDto),
      drive: drive ? driveDto(drive) : null,
      driveModule,
      driveConfigured: this.google.configured,
      points,
      // Sellora's staff are "Sellora support" here, never their own names.
      restores: restores.map((r) => ({
        ...r,
        by: {
          type: r.by.type,
          label: r.by.type === 'user' ? (r.by.label ?? null) : 'Sellora support',
        },
      })),
      parts: RESTORE_PART_KEYS.map((p) => ({ part: p, label: RESTORE_PARTS[p].label })),
    };
  }

  // ---------------------------------------------------------------- download your data

  async requestExport(orgId: string, by: Actor): Promise<ExportDto> {
    const org = new Types.ObjectId(orgId);
    let record: BackupExportDoc;
    try {
      record = (
        await this.exports.create({
          orgId: org,
          status: 'running',
          requestedBy: by,
          startedAt: new Date(),
          downloads: 0,
          lockKey: `export:${orgId}`,
        })
      ).toObject() as unknown as BackupExportDoc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw AppError.conflict(
          'export_running',
          'A download is being prepared. It is ready in a few minutes.',
        );
      throw err;
    }
    const id = record._id.toHexString();
    await this.queue.add(
      BACKUP_JOBS.export,
      { exportId: id },
      { jobId: `export-${id}`, attempts: 1 },
    );
    await this.audit.record({
      orgId,
      action: 'backup.export_requested',
      target: { type: 'backup_export', id, label: 'Download of the data' },
    });
    return exportDto(record);
  }

  /** The worker's part: writes the ZIP and keeps it in storage for 7 days. Never throws. */
  async runExport(exportId: string): Promise<ExportDto> {
    const record = await this.exports.findById(exportId).lean<BackupExportDoc>().exec();
    if (!record) throw AppError.notFound('export');
    if (record.status !== 'running') return exportDto(record);
    const temp = this.tmp(`sellora-export-${exportId}.zip`);
    const key = `backups/orgs/${record.orgId.toHexString()}/exports/${exportId}.zip`;
    try {
      const { size, counts } = await this.zipTo(record.orgId, temp);
      await this.storage.putFile(key, temp, ZIP);
      const now = new Date();
      await this.exports.updateOne(
        { _id: record._id },
        {
          $set: {
            status: 'ready',
            key,
            size,
            counts,
            finishedAt: now,
            expiresAt: new Date(now.getTime() + EXPORT_KEEP_MS),
          },
          $unset: { lockKey: 1 },
        },
      );
    } catch (err) {
      this.logger.error({ err, exportId }, 'Data download failed');
      await this.storage.delete(key).catch(() => undefined);
      await this.exports.updateOne(
        { _id: record._id },
        {
          $set: { status: 'failed', error: describe(err), finishedAt: new Date() },
          $unset: { lockKey: 1 },
        },
      );
    } finally {
      await rm(temp, { force: true });
    }
    return exportDto((await this.exports.findById(exportId).lean<BackupExportDoc>().exec())!);
  }

  private async zipTo(orgId: Types.ObjectId, path: string) {
    const org = await this.orgs.get(orgId.toHexString());
    await mkdir(join(path, '..'), { recursive: true });
    return writeExport(this.db, orgId, createWriteStream(path), {
      business: org.name,
      currency: org.currency,
    });
  }

  /** A link to a ready download of this business, for 10 minutes. */
  async exportLink(orgId: string, exportId: string): Promise<{ url: string; expiresAt: string }> {
    const record = Types.ObjectId.isValid(exportId)
      ? await this.exports
          .findOne({ _id: exportId, orgId: new Types.ObjectId(orgId) })
          .lean<BackupExportDoc>()
          .exec()
      : null;
    if (!record) throw AppError.notFound('export');
    if (record.status !== 'ready')
      throw AppError.conflict('export_not_ready', 'This download is not ready.');
    const exp = Math.floor(Date.now() / 1000) + EXPORT_LINK_SECONDS;
    const token = this.signer.sign({ p: 'export', e: exportId, o: orgId, exp });
    await this.exports.updateOne({ _id: record._id }, { $inc: { downloads: 1 } });
    await this.audit.record({
      orgId,
      action: 'backup.export_downloaded',
      target: { type: 'backup_export', id: exportId, label: 'Download of the data' },
      metadata: { size: record.size },
    });
    const api = this.config.get('API_PUBLIC_URL').replace(/\/+$/, '');
    return {
      url: `${api}/v1/backups/exports/${token}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async openExport(token: string): Promise<{ body: Readable; filename: string; size: number }> {
    const claims = this.signer.verify<{ p?: string; e?: string; o?: string; exp: number }>(token);
    if (claims?.p !== 'export' || !claims.e || !claims.o || !Types.ObjectId.isValid(claims.e))
      throw AppError.notFound('export');
    const record = await this.exports
      .findOne({ _id: claims.e, orgId: new Types.ObjectId(claims.o), status: 'ready' })
      .lean<BackupExportDoc>()
      .exec();
    const obj = record?.key ? await this.storage.open(record.key) : null;
    if (!record || !obj) throw AppError.notFound('export');
    const org = await this.orgs.get(claims.o);
    const slug = (org.slug ?? 'business').replace(/[^a-z0-9-]/gi, '');
    const day = record.startedAt.toISOString().slice(0, 10);
    return {
      body: obj.body,
      filename: `sellora-${slug}-data-${day}.zip`,
      size: record.size ?? obj.size,
    };
  }

  /** Removes downloads older than 7 days. */
  async expireExports(now = new Date()): Promise<number> {
    const old = await this.exports
      .find({ status: 'ready', expiresAt: { $lt: now } })
      .lean<BackupExportDoc[]>()
      .exec();
    for (const e of old) {
      if (e.key) await this.storage.delete(e.key).catch(() => undefined);
      await this.exports.updateOne(
        { _id: e._id },
        { $set: { status: 'expired' }, $unset: { key: 1 } },
      );
    }
    return old.length;
  }

  // ---------------------------------------------------------------- restore points and restores

  makeRestorePoint(orgId: string, by: Actor) {
    return this.backups.request({ orgId, by, reason: 'merchant' });
  }

  /** The same preview as the super-admin's, without the backup file's own details. */
  async preview(orgId: string, runId: string) {
    const p = await this.backups.preview(orgId, runId);
    return {
      run: { id: p.run.id, startedAt: p.run.startedAt },
      business: p.business,
      parts: p.parts,
    };
  }

  /** The owner's or an admin's restore: the person's password, then as the super-admin's. */
  async restore(
    orgId: string,
    input: {
      runId: string;
      parts: RestorePart[];
      reason: string;
      confirmName: string;
      password: string;
    },
    user: { id: string },
  ) {
    const key = user.id;
    await this.limits.assertNotBlocked('login-fail:account', key);
    const found = await this.users.findWithSecrets({ _id: new Types.ObjectId(user.id) });
    if (!found || !(await this.passwords.verify(found.passwordHash, input.password))) {
      await this.limits.consume('login-fail:account', key);
      await this.audit.recordSafe({
        orgId,
        action: 'backup.restore_password_failed',
        outcome: 'failure',
        target: { type: 'organization', id: orgId },
      });
      throw AppError.validation([{ path: 'password', message: 'The password is not right.' }]);
    }
    return this.backups.requestRestore(
      orgId,
      input.runId,
      { parts: input.parts, reason: input.reason, confirmName: input.confirmName },
      { type: 'user', id: user.id, label: found.email },
    );
  }

  // ---------------------------------------------------------------- Google Drive

  private async assertDrive(orgId: string): Promise<void> {
    await this.entitlements.assertModules(orgId, ['backups_drive']);
    if (!this.google.configured)
      throw AppError.conflict(
        'drive_not_configured',
        'Google Drive is not set up on this server yet.',
      );
  }

  /** Google's consent page for this business, with a single-use state. */
  async connectUrl(orgId: string, userId: string): Promise<{ url: string }> {
    await this.assertDrive(orgId);
    const nonce = randomBytes(18).toString('base64url');
    await this.redis.set(`gdrive-state:${nonce}`, JSON.stringify({ orgId, userId }), 'EX', 900);
    const state = this.signer.sign({
      p: 'gdrive',
      n: nonce,
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    const user = await this.users.findById(userId);
    return { url: this.google.consentUrl(state, user?.email) };
  }

  /**
   * Google sends the browser back here. Returns where to send it on: the business's Backups
   * page with `drive=connected`, or `drive=<problem>`.
   */
  async callback(q: { code?: string; state?: string; error?: string }): Promise<string> {
    const claims = q.state
      ? this.signer.verify<{ p?: string; n?: string; exp: number }>(q.state)
      : null;
    const saved =
      claims?.p === 'gdrive' && claims.n
        ? await this.redis.getdel(`gdrive-state:${claims.n}`)
        : null;
    if (!saved) return `${this.web()}/app?drive=expired`;
    const { orgId, userId } = JSON.parse(saved) as { orgId: string; userId: string };
    const back = (result: string) => `${this.web()}/app/${orgId}/settings/backups?drive=${result}`;
    if (q.error || !q.code) return back(q.error === 'access_denied' ? 'denied' : 'failed');
    try {
      await this.assertDrive(orgId);
      const tokens = await this.google.exchange(q.code);
      if (!tokens.scope.split(' ').includes(DRIVE_SCOPE)) {
        await this.google.revoke(tokens.refreshToken);
        return back('no_permission');
      }
      const [org, user, email] = await Promise.all([
        this.orgs.get(orgId),
        this.users.findById(userId),
        this.google.email(tokens.accessToken),
      ]);
      const folder = await this.google.createFolder(
        tokens.accessToken,
        `Sellora backups - ${org.name}`,
      );
      const before = await this.drives
        .findOne({ orgId: org._id })
        .lean<DriveConnectionDoc>()
        .exec();
      await this.drives.updateOne(
        { orgId: org._id },
        {
          $set: {
            status: 'connected',
            email,
            folderId: folder.id,
            folderName: folder.name,
            refreshTokenEnc: this.encryption.encrypt(tokens.refreshToken, `drive:${orgId}`),
            connectedBy: {
              type: 'user',
              id: userId,
              ...(user?.email ? { label: user.email } : {}),
            },
            connectedAt: new Date(),
          },
          $setOnInsert: { enabled: true, keep: 7 },
          $unset: { lastError: 1, failures: 1, reconnectMailedAt: 1, busyUntil: 1 },
        },
        { upsert: true },
      );
      if (before && before.refreshTokenEnc)
        await this.google
          .revoke(this.encryption.decrypt(before.refreshTokenEnc, `drive:${orgId}`))
          .catch(() => undefined);
      await this.audit.record({
        orgId,
        actor: { type: 'user', id: userId, ...(user?.email ? { label: user.email } : {}) },
        action: 'backup.drive_connected',
        target: { type: 'drive', id: folder.id, label: email },
      });
      // The first copy goes now, not tomorrow night.
      await this.queue.add(
        BACKUP_JOBS.driveCopy,
        { orgId },
        { jobId: `drive-${orgId}-${Date.now()}`, attempts: 1 },
      );
      return back('connected');
    } catch (err) {
      this.logger.error({ err, orgId }, 'Google Drive connection failed');
      return back('failed');
    }
  }

  async updateDrive(orgId: string, patch: { enabled?: boolean; keep?: number }): Promise<DriveDto> {
    const set: Record<string, unknown> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.keep !== undefined) set.keep = patch.keep;
    const doc = await this.drives
      .findOneAndUpdate(
        { orgId: new Types.ObjectId(orgId) },
        { $set: set },
        { returnDocument: 'after' },
      )
      .lean<DriveConnectionDoc>()
      .exec();
    if (!doc) throw AppError.notFound('drive');
    await this.audit.record({
      orgId,
      action: 'backup.drive_updated',
      target: { type: 'drive', id: doc.folderId, label: doc.email },
      metadata: set,
    });
    return driveDto(doc);
  }

  async disconnect(orgId: string): Promise<void> {
    const doc = await this.drives
      .findOneAndDelete({ orgId: new Types.ObjectId(orgId) })
      .lean<DriveConnectionDoc>()
      .exec();
    if (!doc) return;
    await this.google
      .revoke(this.encryption.decrypt(doc.refreshTokenEnc, `drive:${orgId}`))
      .catch(() => undefined);
    await this.audit.record({
      orgId,
      action: 'backup.drive_disconnected',
      target: { type: 'drive', id: doc.folderId, label: doc.email },
    });
  }

  async copyNow(orgId: string): Promise<DriveDto> {
    await this.assertDrive(orgId);
    const doc = await this.drives
      .findOne({ orgId: new Types.ObjectId(orgId) })
      .lean<DriveConnectionDoc>()
      .exec();
    if (!doc) throw AppError.notFound('drive');
    if (doc.status !== 'connected')
      throw AppError.conflict('drive_reconnect', 'Connect Google Drive again first.');
    if (doc.busyUntil && doc.busyUntil > new Date())
      throw AppError.conflict(
        'drive_copy_running',
        'A copy is being saved to Google Drive right now.',
      );
    await this.queue.add(
      BACKUP_JOBS.driveCopy,
      { orgId },
      { jobId: `drive-${orgId}-${Date.now()}`, attempts: 1 },
    );
    return driveDto(doc);
  }

  /**
   * Saves today's copy to the business's Drive (the same ZIP as "Download your data") and
   * removes the oldest copies beyond the number kept. Never throws: the result is recorded.
   */
  async runDriveCopy(orgId: string, now = new Date()): Promise<DriveDto | null> {
    const business = await this.orgs.get(orgId).catch(() => null);
    if (!business) return null;
    const org = business._id;
    const claimed = await this.drives
      .findOneAndUpdate(
        {
          orgId: org,
          status: 'connected',
          $or: [{ busyUntil: { $exists: false } }, { busyUntil: { $lt: now } }],
        },
        { $set: { busyUntil: new Date(now.getTime() + DRIVE_LEASE_MS), lastAttemptAt: now } },
        { returnDocument: 'after' },
      )
      .lean<DriveConnectionDoc>()
      .exec();
    if (!claimed) return null;
    const temp = this.tmp(`sellora-drive-${orgId}.zip`);
    const tz = business.timezone;
    const slot = scheduledSlot(now, DRIVE_HOUR, tz);
    try {
      if (!(await this.entitlements.hasModule(orgId, 'backups_drive')))
        throw new Error('Your plan no longer includes Google Drive backup');
      const token = await this.google.accessToken(
        this.encryption.decrypt(claimed.refreshTokenEnc, `drive:${orgId}`),
      );
      let folderId = claimed.folderId;
      if (!(await this.google.folderExists(token, folderId))) {
        const folder = await this.google.createFolder(token, claimed.folderName);
        folderId = folder.id;
      }
      const { size } = await this.zipTo(org, temp);
      const stamp = new Intl.DateTimeFormat('sv-SE', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .format(now)
        .replace(' ', '-')
        .replace(':', '');
      const slug = (business.slug ?? 'business').replace(/[^a-z0-9-]/gi, '');
      const file = await this.google.upload(token, {
        folderId,
        name: `sellora-${slug}-${stamp}.zip`,
        path: temp,
        size,
        contentType: ZIP,
      });
      // Only Sellora's own copies are counted and removed; anything else in the folder stays.
      const copies = (await this.google.list(token, folderId)).filter(
        (f) => f.name.startsWith('sellora-') && f.name.endsWith('.zip'),
      );
      for (const old of copies.slice(claimed.keep))
        await this.google.remove(token, old.id).catch(() => undefined);
      await this.drives.updateOne(
        { _id: claimed._id },
        {
          $set: {
            folderId,
            lastSuccessAt: now,
            lastFile: { id: file.id, name: file.name, size: file.size, at: now },
          },
          $unset: { busyUntil: 1, queuedAt: 1, lastError: 1, failures: 1 },
        },
      );
    } catch (err) {
      const message =
        err instanceof GoogleError || err instanceof Error ? err.message : describe(err);
      this.logger.warn({ err, orgId }, 'Google Drive copy failed');
      const failures =
        claimed.failures?.slot && claimed.failures.slot.getTime() === slot.getTime()
          ? { slot, count: claimed.failures.count + 1 }
          : { slot, count: 1 };
      const revoked = err instanceof GoogleError && err.kind === 'revoked';
      await this.drives.updateOne(
        { _id: claimed._id },
        {
          $set: {
            lastError: message.slice(0, 300),
            failures,
            ...(revoked ? { status: 'reconnect' } : {}),
          },
          $unset: { busyUntil: 1, queuedAt: 1 },
        },
      );
      if (revoked && !claimed.reconnectMailedAt) await this.tellReconnect(orgId, claimed.email);
    } finally {
      await rm(temp, { force: true });
    }
    return driveDto((await this.drives.findById(claimed._id).lean<DriveConnectionDoc>().exec())!);
  }

  private async tellReconnect(orgId: string, email: string): Promise<void> {
    try {
      const org = await this.orgs.get(orgId);
      const [owner] = await this.users.findByIds([org.ownerUserId]);
      if (!owner) return;
      await this.mail.send({
        to: owner.email,
        category: 'account',
        ...mailTemplates.driveReconnect(owner.locale, {
          businessName: org.name,
          email,
          url: `${this.web()}/app/${orgId}/settings/backups`,
        }),
      });
      await this.drives.updateOne({ orgId: org._id }, { $set: { reconnectMailedAt: new Date() } });
    } catch (err) {
      this.logger.error({ err, orgId }, 'Could not email the owner about Google Drive');
    }
  }

  /**
   * The worker's sweep: queues today's Drive copies that are due (04:00 in each business's
   * zone), each at most once while it waits. Returns how many were queued.
   */
  async driveSweep(now = new Date()): Promise<number> {
    const all = await this.drives
      .find(
        { status: 'connected', enabled: true },
        { orgId: 1, lastSuccessAt: 1, lastAttemptAt: 1, failures: 1, busyUntil: 1, queuedAt: 1 },
      )
      .lean<DriveConnectionDoc[]>()
      .exec();
    let queued = 0;
    for (const d of all) {
      if (queued >= DRIVE_PER_SWEEP) break;
      const orgId = d.orgId.toHexString();
      const org = await this.orgs.get(orgId).catch(() => null);
      if (!org || !driveDue(d, now, scheduledSlot(now, DRIVE_HOUR, org.timezone))) continue;
      const claimed = await this.drives.updateOne(
        {
          _id: d._id,
          $or: [
            { queuedAt: { $exists: false } },
            { queuedAt: { $lt: new Date(now.getTime() - DRIVE_LEASE_MS) } },
          ],
        },
        { $set: { queuedAt: now } },
      );
      if (!claimed.modifiedCount) continue;
      await this.queue.add(
        BACKUP_JOBS.driveCopy,
        { orgId },
        { jobId: `drive-${orgId}-${now.getTime()}`, attempts: 1 },
      );
      queued += 1;
    }
    return queued;
  }
}

/** Whether a business's Drive copy for the day's slot is due now. */
export function driveDue(
  d: Pick<
    DriveConnection,
    'lastSuccessAt' | 'lastAttemptAt' | 'failures' | 'busyUntil' | 'queuedAt'
  >,
  now: Date,
  slot: Date,
): boolean {
  if (now < slot) return false;
  if (d.lastSuccessAt && d.lastSuccessAt >= slot) return false;
  if (
    d.failures?.slot &&
    d.failures.slot.getTime() === slot.getTime() &&
    d.failures.count >= DRIVE_MAX_ATTEMPTS
  )
    return false;
  if (
    d.lastAttemptAt &&
    d.lastAttemptAt >= slot &&
    now.getTime() - d.lastAttemptAt.getTime() < DRIVE_RETRY_MS
  )
    return false;
  if (d.busyUntil && d.busyUntil > now) return false;
  if (d.queuedAt && now.getTime() - d.queuedAt.getTime() < DRIVE_LEASE_MS) return false;
  return true;
}

function exportDto(r: BackupExportDoc): ExportDto {
  return {
    id: r._id.toHexString(),
    status: r.status,
    size: r.size ?? null,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    error: r.error ?? null,
    requestedBy: r.requestedBy?.label ?? null,
    downloads: r.downloads ?? 0,
  };
}

function driveDto(d: DriveConnectionDoc): DriveDto {
  return {
    status: d.status,
    email: d.email,
    folderName: d.folderName,
    enabled: d.enabled,
    keep: d.keep,
    connectedAt: d.connectedAt.toISOString(),
    connectedBy: d.connectedBy?.label ?? null,
    lastSuccessAt: d.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: d.lastAttemptAt?.toISOString() ?? null,
    lastError: d.lastError ?? null,
    lastFile: d.lastFile?.at
      ? { name: d.lastFile.name, size: d.lastFile.size, at: d.lastFile.at.toISOString() }
      : null,
    copying: Boolean(d.busyUntil && d.busyUntil > new Date()),
  };
}
