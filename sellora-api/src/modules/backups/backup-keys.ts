import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { S3StorageDriver } from '../../infra/storage/s3.driver.js';
import { parseKeyring, type BackupKey } from './backup-format.js';

/** The keys backups are encrypted with (ADR 0020). */
@Injectable()
export class BackupKeys {
  readonly active: BackupKey;
  private readonly all: Map<string, Buffer>;

  constructor(config: AppConfig) {
    const spec = config.get('BACKUP_ENCRYPTION_KEYS');
    if (spec) {
      ({ active: this.active, all: this.all } = parseKeyring(
        spec,
        config.get('BACKUP_ENCRYPTION_ACTIVE_KID') ?? '',
      ));
    } else {
      // Development only (production refuses to start without backup keys, see env.ts).
      new Logger(BackupKeys.name).warn(
        'BACKUP_ENCRYPTION_KEYS is not set; backups use the data encryption keys',
      );
      ({ active: this.active, all: this.all } = parseKeyring(
        config.get('DATA_ENCRYPTION_KEYS'),
        config.get('DATA_ENCRYPTION_ACTIVE_KID'),
      ));
    }
  }

  get(kid: string): Buffer | undefined {
    return this.all.get(kid);
  }
}

/** The optional second bucket for off-site copies, or null when it is not configured. */
export abstract class OffsiteStorage {
  abstract readonly driver: S3StorageDriver | null;
}

export function offsiteFromConfig(config: AppConfig): OffsiteStorage {
  const bucket = config.get('BACKUP_OFFSITE_S3_BUCKET');
  const accessKeyId = config.get('BACKUP_OFFSITE_S3_ACCESS_KEY_ID');
  const secretAccessKey = config.get('BACKUP_OFFSITE_S3_SECRET_ACCESS_KEY');
  const driver =
    bucket && accessKeyId && secretAccessKey
      ? new S3StorageDriver({
          endpoint: config.get('BACKUP_OFFSITE_S3_ENDPOINT'),
          region: config.get('BACKUP_OFFSITE_S3_REGION'),
          bucket,
          accessKeyId,
          secretAccessKey,
          forcePathStyle: config.get('BACKUP_OFFSITE_S3_FORCE_PATH_STYLE'),
          apiPublicUrl: config.get('API_PUBLIC_URL'),
        })
      : null;
  return { driver };
}
