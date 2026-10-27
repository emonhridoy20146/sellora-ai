import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingModule } from '../billing/billing.module.js';
import { FilesController, StorageController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { StorageUsageRepository, StoredFileRepository } from './repositories.js';
import { storageUsageSchema, storedFileSchema } from './schemas.js';

/** Uploads, per-business storage accounting and file serving. */
@Module({
  imports: [
    BillingModule,
    MongooseModule.forFeature([
      { name: 'StoredFile', schema: storedFileSchema },
      { name: 'StorageUsage', schema: storageUsageSchema },
    ]),
  ],
  controllers: [FilesController, StorageController],
  providers: [StoredFileRepository, StorageUsageRepository, FilesService],
  exports: [FilesService],
})
export class FilesModule {}

/** The same module without HTTP routes, for the background worker. */
@Module({
  imports: [
    BillingModule,
    MongooseModule.forFeature([
      { name: 'StoredFile', schema: storedFileSchema },
      { name: 'StorageUsage', schema: storageUsageSchema },
    ]),
  ],
  providers: [StoredFileRepository, StorageUsageRepository, FilesService],
  exports: [FilesService],
})
export class FilesCoreModule {}
