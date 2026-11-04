import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfig } from '../../config/app-config.js';
import { BillingModule } from '../billing/billing.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { UsersModule } from '../users/users.module.js';
import { BackupKeys, OffsiteStorage, offsiteFromConfig } from './backup-keys.js';
import { PlatformBackupsController } from './backups.controller.js';
import { BackupsService } from './backups.service.js';
import { GOOGLE_FETCH, GoogleDriveClient } from './google-drive.js';
import {
  BackupsPublicController,
  MerchantBackupsController,
} from './merchant-backups.controller.js';
import { MerchantBackupsService } from './merchant-backups.service.js';
import {
  BackupExportSchema,
  BackupRestoreSchema,
  BackupRunSchema,
  BackupSettingsSchema,
  DriveConnectionSchema,
} from './schemas.js';

/**
 * Backups without HTTP routes (ADR 0020, 0021): the worker makes, checks and restores them,
 * prepares downloads and copies to Google Drive.
 */
@Module({
  imports: [
    OrgsModule,
    UsersModule,
    BillingModule,
    MongooseModule.forFeature([
      { name: 'BackupRun', schema: BackupRunSchema },
      { name: 'BackupSettings', schema: BackupSettingsSchema },
      { name: 'BackupRestore', schema: BackupRestoreSchema },
      { name: 'BackupExport', schema: BackupExportSchema },
      { name: 'DriveConnection', schema: DriveConnectionSchema },
    ]),
  ],
  providers: [
    BackupKeys,
    { provide: OffsiteStorage, inject: [AppConfig], useFactory: offsiteFromConfig },
    BackupsService,
    { provide: GOOGLE_FETCH, useValue: globalThis.fetch.bind(globalThis) },
    GoogleDriveClient,
    MerchantBackupsService,
  ],
  exports: [BackupsService, MerchantBackupsService, BackupKeys, OffsiteStorage],
})
export class BackupsCoreModule {}

/** Admin › Backups, and Settings › Backups for each business. */
@Module({
  imports: [BackupsCoreModule, PlatformModule, UsersModule],
  controllers: [PlatformBackupsController, MerchantBackupsController, BackupsPublicController],
})
export class BackupsModule {}
