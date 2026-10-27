import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { StorageUsage, StoredFile } from './schemas.js';

@Injectable()
export class StoredFileRepository extends TenantScopedRepository<StoredFile> {
  constructor(@InjectModel('StoredFile') model: Model<StoredFile>) {
    super(model);
  }
}

@Injectable()
export class StorageUsageRepository extends TenantScopedRepository<StorageUsage> {
  constructor(@InjectModel('StorageUsage') model: Model<StorageUsage>) {
    super(model);
  }
}
