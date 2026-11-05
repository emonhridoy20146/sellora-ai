import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SafeHttp } from '../../infra/http/safe-http.js';
import { AuthCoreModule } from '../auth/core/auth-core.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { FilesCoreModule } from '../files/files.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { DNS_LOOKUP, NodeDnsLookup } from '../stores/dns-lookup.js';
import { CatalogSyncController } from './catalog-sync.controller.js';
import { CatalogSyncRunner } from './catalog-sync.runner.js';
import { CatalogSyncService } from './catalog-sync.service.js';
import { CatalogSourceRepository, CatalogSyncRunRepository } from './repositories.js';
import { catalogSourceSchema, catalogSyncRunSchema } from './schemas.js';

/**
 * Catalog sync without HTTP routes (ADR 0023, 0024): the worker runs the syncs and website
 * crawls with it; the feature module below adds Products › Import and sync.
 */
@Module({
  imports: [
    AuthCoreModule,
    BillingModule,
    CommerceCoreModule,
    FilesCoreModule,
    KnowledgeModule,
    OrgsModule,
    MongooseModule.forFeature([
      { name: 'CatalogSource', schema: catalogSourceSchema },
      { name: 'CatalogSyncRun', schema: catalogSyncRunSchema },
    ]),
  ],
  providers: [
    SafeHttp,
    { provide: DNS_LOOKUP, useClass: NodeDnsLookup },
    CatalogSourceRepository,
    CatalogSyncRunRepository,
    CatalogSyncService,
    CatalogSyncRunner,
  ],
  exports: [CatalogSyncService, CatalogSyncRunner, SafeHttp],
})
export class CatalogSyncCoreModule {}

@Module({
  imports: [CatalogSyncCoreModule],
  controllers: [CatalogSyncController],
})
export class CatalogSyncModule {}
