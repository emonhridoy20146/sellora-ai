import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError, type FieldError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { AppConfig } from '../../config/app-config.js';
import { CROSS_TENANT } from '../../infra/database/tenant-guard.plugin.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { IMAGE_TYPES, SNIFF_BYTES, sniffImageType } from '../../infra/storage/content-types.js';
import { StorageDriver, type UploadTarget } from '../../infra/storage/storage.driver.js';
import type { FeatureModule } from '../billing/feature-modules.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import type { Permission } from '../iam/permissions.js';
import { StorageUsageRepository, StoredFileRepository } from './repositories.js';
import type { FilePurpose, FileRef, StoredFile } from './schemas.js';

export type FileDoc = WithId<StoredFile>;

const MB = 1024 * 1024;
/** Uploads a business may have in flight at once. */
const MAX_PENDING = 50;
/** Time after the upload link expires to finish the upload check. */
const COMPLETE_GRACE_MS = 30 * 60_000;
/** Uploaded files nothing refers to are removed after this long. */
const UNUSED_TTL_MS = 24 * 3600_000;

interface PurposeRule {
  types: readonly string[];
  maxBytes: (config: AppConfig) => number;
  visibility: 'public' | 'private';
  /** Folder inside the business's storage prefix. */
  dir: string;
  module: FeatureModule;
  permission: Permission;
  /** Remove the file once nothing refers to it any more. */
  removeWhenUnused: boolean;
}

const imageMax = (config: AppConfig) => config.get('FILE_MAX_IMAGE_MB') * MB;

export const FILE_RULES: Record<FilePurpose, PurposeRule> = {
  product_image: {
    types: Object.keys(IMAGE_TYPES),
    maxBytes: imageMax,
    visibility: 'public',
    dir: 'products',
    module: 'commerce',
    permission: 'catalog.manage',
    removeWhenUnused: true,
  },
};

/** Keys look like o/<orgId>/<dir>/<fileId>.<ext>; the storage route accepts nothing else. */
export const FILE_KEY = /^o\/([a-f0-9]{24})\/[a-z_-]+\/[a-f0-9]{24}\.(jpg|png|webp|gif|avif)$/;

export function toFileDto(f: FileDoc, storage: StorageDriver) {
  return {
    id: f._id.toHexString(),
    purpose: f.purpose,
    filename: f.filename,
    contentType: f.contentType,
    size: f.size,
    status: f.status,
    url: f.status === 'ready' ? storage.publicUrl(f.key) : null,
    inUse: f.usedBy.length > 0,
    createdAt: f.createdAt.toISOString(),
  };
}

function cleanFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  return (cleaned || 'file').slice(0, 200);
}

/**
 * Uploads and the storage they use. The browser asks for an upload link, sends the bytes
 * straight to storage, then asks us to check the result. Storage is counted per business
 * against the plan's `storageMb` limit: space is reserved when the link is handed out, so
 * parallel uploads cannot pass the limit, and released when a file is removed.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly files: StoredFileRepository,
    private readonly usage: StorageUsageRepository,
    private readonly storage: StorageDriver,
    private readonly entitlements: EntitlementsService,
    private readonly config: AppConfig,
    @InjectModel('StoredFile') private readonly fileModel: Model<StoredFile>,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  private assertCan(rule: PurposeRule) {
    const perms = RequestContext.tenant()!.permissions;
    if (!perms.has('*') && !perms.has(rule.permission))
      throw new AppError('missing_permission', 403, 'Your role does not allow this action.', {
        required: [rule.permission],
      });
  }

  // ---------------------------------------------------------------- quota

  private async limitBytes(): Promise<number | null> {
    const mb = (await this.entitlements.forOrg(this.orgId())).limits.storageMb;
    return mb === null ? null : mb * MB;
  }

  /** Reserves `bytes` of the plan's storage, or throws 402 when they do not fit. */
  private async reserve(bytes: number): Promise<void> {
    try {
      await this.usage.findOneAndUpdate(
        {},
        { $setOnInsert: { usedBytes: 0 } },
        { upsert: true, returnDocument: 'before' },
      );
    } catch (err) {
      // Two first uploads raced to create the counter; the other one did.
      if (!isDuplicateKey(err)) throw err;
    }
    const limit = await this.limitBytes();
    const ok = await this.usage.findOneAndUpdate(
      limit === null ? {} : { usedBytes: { $lte: limit - bytes } },
      { $inc: { usedBytes: bytes } },
    );
    if (!ok) {
      const used = (await this.usage.findOne({}))?.usedBytes ?? 0;
      throw AppError.paymentRequired(
        'plan_limit_reached',
        `Your plan includes ${Math.round(limit! / MB)} MB of storage and ${Math.round(used / MB)} MB is used. Remove files or upgrade to add more.`,
        { limit: 'storageMb', max: Math.round(limit! / MB), current: used / MB },
      );
    }
  }

  private async release(bytes: number): Promise<void> {
    await this.usage.updateOne({}, { $inc: { usedBytes: -bytes } });
  }

  async storageUsage() {
    const [doc, limit] = await Promise.all([this.usage.findOne({}), this.limitBytes()]);
    return { usedBytes: Math.max(0, doc?.usedBytes ?? 0), limitBytes: limit };
  }

  // ---------------------------------------------------------------- uploads

  async createUpload(input: {
    purpose: FilePurpose;
    filename: string;
    contentType: string;
    size: number;
  }): Promise<{ file: FileDoc; upload: UploadTarget }> {
    const rule = FILE_RULES[input.purpose];
    this.assertCan(rule);
    await this.entitlements.assertModules(this.orgId(), [rule.module]);
    const contentType = input.contentType.toLowerCase();
    const errors: FieldError[] = [];
    if (!rule.types.includes(contentType))
      errors.push({
        path: 'contentType',
        message: 'Upload a JPG, PNG, WebP, GIF or AVIF image.',
      });
    const max = rule.maxBytes(this.config);
    if (input.size > max)
      errors.push({ path: 'size', message: `Files can be up to ${Math.round(max / MB)} MB.` });
    if (errors.length) throw AppError.validation(errors);
    if ((await this.files.count({ status: 'pending' })) >= MAX_PENDING)
      throw new AppError(
        'too_many_uploads',
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many uploads are in progress. Wait for them to finish and try again.',
      );

    await this.reserve(input.size);
    const id = new Types.ObjectId();
    const key = `o/${this.orgId()}/${rule.dir}/${id.toHexString()}.${IMAGE_TYPES[contentType as keyof typeof IMAGE_TYPES]}`;
    const ttl = this.config.get('STORAGE_UPLOAD_TTL_SECONDS');
    let file: FileDoc;
    try {
      const actor = RequestContext.actor();
      file = await this.files.create({
        _id: id,
        key,
        purpose: input.purpose,
        filename: cleanFilename(input.filename),
        contentType,
        size: input.size,
        status: 'pending',
        visibility: rule.visibility,
        usedBy: [],
        createdBy: { type: actor.type, id: actor.id },
        expiresAt: new Date(Date.now() + ttl * 1000 + COMPLETE_GRACE_MS),
      });
    } catch (err) {
      await this.release(input.size);
      throw err;
    }
    const upload = await this.storage.createUpload(key, contentType, input.size, ttl);
    return { file, upload };
  }

  /** Checks an upload landed whole and is what it claims to be, then marks it ready. */
  async complete(id: string): Promise<FileDoc> {
    const file = await this.get(id);
    this.assertCan(FILE_RULES[file.purpose]);
    if (file.status === 'ready') return file;
    if (file.expiresAt && file.expiresAt.getTime() < Date.now())
      throw AppError.conflict(
        'upload_expired',
        'This upload took too long. Upload the file again.',
      );
    const head = await this.storage.head(file.key);
    if (!head)
      throw AppError.conflict(
        'upload_not_received',
        'The file has not finished uploading. Try again in a moment.',
      );
    if (head.size !== file.size) {
      await this.purge(file, { status: 'pending' });
      throw AppError.unprocessable(
        'upload_size_mismatch',
        'The uploaded file is not the size that was announced. Upload it again.',
      );
    }
    const actual = sniffImageType(await this.storage.readStart(file.key, SNIFF_BYTES));
    if (actual !== file.contentType) {
      await this.purge(file, { status: 'pending' });
      throw AppError.unprocessable(
        'upload_type_mismatch',
        'The uploaded file is not a valid image of the announced type.',
      );
    }
    const ready = await this.files.findOneAndUpdate(
      { _id: file._id, status: 'pending' },
      { $set: { status: 'ready', readyAt: new Date() }, $unset: { expiresAt: '' } },
    );
    if (ready) return ready;
    const now = await this.files.findById(id);
    if (now?.status === 'ready') return now;
    throw AppError.conflict('upload_expired', 'This upload took too long. Upload the file again.');
  }

  publicUrl(file: FileDoc): string {
    return this.storage.publicUrl(file.key);
  }

  async get(id: string): Promise<FileDoc> {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('file');
    const file = await this.files.findById(id);
    if (!file) throw AppError.notFound('file');
    return file;
  }

  /** Deletes a file nothing uses. */
  async remove(id: string): Promise<void> {
    const file = await this.get(id);
    this.assertCan(FILE_RULES[file.purpose]);
    if (file.usedBy.length)
      throw AppError.conflict('file_in_use', 'This file is still in use.', {
        usedBy: file.usedBy,
      });
    if (!(await this.purge(file, { usedBy: { $size: 0 } })))
      throw AppError.conflict('file_in_use', 'This file is still in use.');
  }

  /**
   * Deletes the record (only while `guard` still matches, so a file that just became used
   * survives), then the bytes, then gives the space back. Returns whether it was deleted.
   */
  private async purge(file: FileDoc, guard: Record<string, unknown>): Promise<boolean> {
    if (!(await this.files.deleteOne({ _id: file._id, ...guard }))) return false;
    await this.release(file.size);
    try {
      await this.storage.delete(file.key);
    } catch (err) {
      this.logger.error({ err, key: file.key }, 'Deleted a file record but not its object');
    }
    return true;
  }

  // ---------------------------------------------------------------- references

  /**
   * Marks ready files as used by `ref` and returns them by id. Throws 422 (at `path`) when one
   * is missing, still uploading, or of another purpose. Safe inside a transaction.
   */
  async attach(
    ids: string[],
    ref: FileRef,
    purpose: FilePurpose,
    path: (index: number) => string,
  ): Promise<Map<string, FileDoc>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const valid = unique.filter((i) => Types.ObjectId.isValid(i));
    const found = await this.files.find({
      _id: { $in: valid.map((i) => new Types.ObjectId(i)) },
      status: 'ready',
      purpose,
    });
    const byId = new Map(found.map((f) => [f._id.toHexString(), f]));
    const errors = ids.flatMap((id, i) =>
      byId.has(id)
        ? []
        : [{ path: path(i), message: 'This photo is not uploaded yet or no longer exists.' }],
    );
    if (errors.length) throw AppError.validation(errors);
    await this.files.updateMany(
      { _id: { $in: found.map((f) => f._id) } },
      { $addToSet: { usedBy: ref } },
    );
    return byId;
  }

  /** Removes `ref` from the files. Safe inside a transaction. */
  async detach(ids: string[], ref: FileRef): Promise<void> {
    const valid = [...new Set(ids)].filter((i) => Types.ObjectId.isValid(i));
    if (valid.length === 0) return;
    await this.files.updateMany(
      { _id: { $in: valid.map((i) => new Types.ObjectId(i)) } },
      { $pull: { usedBy: ref } },
    );
  }

  /** Deletes those of `ids` that nothing uses and whose purpose allows it. Run after commit. */
  async removeIfUnused(ids: string[]): Promise<number> {
    const valid = [...new Set(ids)].filter((i) => Types.ObjectId.isValid(i));
    if (valid.length === 0) return 0;
    const unused = await this.files.find({
      _id: { $in: valid.map((i) => new Types.ObjectId(i)) },
      usedBy: { $size: 0 },
    });
    let removed = 0;
    for (const f of unused) {
      if (!FILE_RULES[f.purpose].removeWhenUnused) continue;
      if (await this.purge(f, { usedBy: { $size: 0 } })) removed += 1;
    }
    return removed;
  }

  // ---------------------------------------------------------------- serving and cleanup

  /** A ready file by its storage key, for the public storage route. */
  async findReadyByKey(key: string): Promise<FileDoc | null> {
    const match = FILE_KEY.exec(key);
    if (!match) return null;
    return RequestContext.withTenant(match[1]!, () => this.files.findOne({ key, status: 'ready' }));
  }

  /**
   * Removes uploads that never completed and files nothing has used for a day. Runs across
   * businesses, each in its own tenant scope; one failure never stops the sweep.
   */
  async sweep(now = new Date()): Promise<{ expired: number; unused: number; failed: number }> {
    const counts = { expired: 0, unused: 0, failed: 0 };
    const autoPurposes = (Object.keys(FILE_RULES) as FilePurpose[]).filter(
      (p) => FILE_RULES[p].removeWhenUnused,
    );
    const batches: [keyof typeof counts, Record<string, unknown>, Record<string, unknown>][] = [
      ['expired', { status: 'pending', expiresAt: { $lt: now } }, { status: 'pending' }],
      [
        'unused',
        {
          status: 'ready',
          purpose: { $in: autoPurposes },
          readyAt: { $lt: new Date(now.getTime() - UNUSED_TTL_MS) },
          usedBy: { $size: 0 },
        },
        { usedBy: { $size: 0 } },
      ],
    ];
    for (const [name, filter, guard] of batches) {
      const docs = await this.fileModel
        .find(filter, null, { [CROSS_TENANT]: true })
        .limit(500)
        .lean<FileDoc[]>()
        .exec();
      for (const f of docs) {
        try {
          const done = await RequestContext.withTenant(
            f.orgId.toHexString(),
            () => this.purge(f, guard),
            { type: 'system', id: 'storage-sweep' },
          );
          if (done) counts[name] += 1;
        } catch (err) {
          counts.failed += 1;
          this.logger.error({ err, fileId: f._id.toHexString() }, 'Could not remove a file');
        }
      }
    }
    return counts;
  }
}
