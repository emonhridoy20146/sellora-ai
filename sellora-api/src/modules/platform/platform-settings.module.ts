import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PlatformSettingsService } from './platform-settings.service.js';
import { platformSettingsSchema } from './platform-user.schema.js';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: 'PlatformSettings', schema: platformSettingsSchema }]),
  ],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
