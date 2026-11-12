import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiCoreModule } from '../ai/ai.module.js';
import { GOOGLE_FETCH } from '../backups/google-drive.js';
import { BillingModule } from '../billing/billing.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { StoresCoreModule } from '../stores/stores.module.js';
import { UsersModule } from '../users/users.module.js';
import { KEYWORD_FETCH, KeywordDataClient } from './keyword-data.js';
import { KeywordsService } from './keywords.service.js';
import {
  ContentDraftRepository,
  KeywordListRepository,
  KeywordResearchRepository,
  SearchConsoleDayRepository,
  SearchConsoleRowRepository,
  SeoBulkRunRepository,
  SeoGoogleRepository,
} from './repositories.js';
import {
  contentDraftSchema,
  keywordListSchema,
  keywordResearchSchema,
  keywordVolumeSchema,
  searchConsoleDaySchema,
  searchConsoleRowSchema,
  seoBulkRunSchema,
  seoGoogleSchema,
} from './schemas.js';
import { SearchConsoleClient } from './search-console.client.js';
import { SearchConsoleService } from './search-console.service.js';
import { SeoAuditService } from './seo-audit.service.js';
import { SeoWriterService } from './seo-writer.service.js';
import { SeoController, SeoPublicController } from './seo.controller.js';

/**
 * The SEO and content studio without HTTP routes (ADR 0032). The worker runs Search Console
 * setup and daily syncs and the bulk optimiser with it.
 */
@Module({
  imports: [
    AiCoreModule,
    BillingModule,
    CommerceCoreModule,
    OrgsModule,
    StoresCoreModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: 'KeywordVolumeCache', schema: keywordVolumeSchema },
      { name: 'KeywordResearch', schema: keywordResearchSchema },
      { name: 'KeywordList', schema: keywordListSchema },
      { name: 'SeoGoogle', schema: seoGoogleSchema },
      { name: 'SearchConsoleDay', schema: searchConsoleDaySchema },
      { name: 'SearchConsoleRow', schema: searchConsoleRowSchema },
      { name: 'SeoBulkRun', schema: seoBulkRunSchema },
      { name: 'ContentDraft', schema: contentDraftSchema },
    ]),
  ],
  providers: [
    { provide: KEYWORD_FETCH, useValue: globalThis.fetch.bind(globalThis) },
    { provide: GOOGLE_FETCH, useValue: globalThis.fetch.bind(globalThis) },
    KeywordDataClient,
    SearchConsoleClient,
    KeywordResearchRepository,
    KeywordListRepository,
    SeoGoogleRepository,
    SearchConsoleDayRepository,
    SearchConsoleRowRepository,
    SeoBulkRunRepository,
    ContentDraftRepository,
    SeoWriterService,
    KeywordsService,
    SearchConsoleService,
    SeoAuditService,
  ],
  exports: [SearchConsoleService, SeoAuditService, SeoWriterService, KeywordsService],
})
export class SeoCoreModule {}

/** The SEO studio's routes, and Google's callback. */
@Module({
  imports: [SeoCoreModule],
  controllers: [SeoController, SeoPublicController],
})
export class SeoModule {}
