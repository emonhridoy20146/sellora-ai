import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { CatalogSource, CatalogSyncRun } from './schemas.js';

export type CatalogSourceDoc = WithId<CatalogSource>;
export type CatalogSyncRunDoc = WithId<CatalogSyncRun>;

@Injectable()
export class CatalogSourceRepository extends TenantScopedRepository<CatalogSource> {
  constructor(@InjectModel('CatalogSource') model: Model<CatalogSource>) {
    super(model);
  }
}

@Injectable()
export class CatalogSyncRunRepository extends TenantScopedRepository<CatalogSyncRun> {
  constructor(@InjectModel('CatalogSyncRun') model: Model<CatalogSyncRun>) {
    super(model);
  }
}
