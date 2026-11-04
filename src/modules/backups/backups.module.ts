import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfig } from '../../config/app-config.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { UsersModule } from '../users/users.module.js';
import { BackupKeys, OffsiteStorage, offsiteFromConfig } from './backup-keys.js';
import { PlatformBackupsController } from './backups.controller.js';
import { BackupsService } from './backups.service.js';
import { BackupRestoreSchema, BackupRunSchema, BackupSettingsSchema } from './schemas.js';

/** Backups without HTTP routes (ADR 0020): the worker makes, checks and restores them. */
@Module({
  imports: [
    OrgsModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: 'BackupRun', schema: BackupRunSchema },
      { name: 'BackupSettings', schema: BackupSettingsSchema },
      { name: 'BackupRestore', schema: BackupRestoreSchema },
    ]),
  ],
  providers: [
    BackupKeys,
    { provide: OffsiteStorage, inject: [AppConfig], useFactory: offsiteFromConfig },
    BackupsService,
  ],
  exports: [BackupsService, BackupKeys, OffsiteStorage],
})
export class BackupsCoreModule {}

/** Admin › Backups. */
@Module({
  imports: [BackupsCoreModule, PlatformModule],
  controllers: [PlatformBackupsController],
})
export class BackupsModule {}
