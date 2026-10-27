import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrgsModule } from '../orgs/orgs.module.js';
import { UsersModule } from '../users/users.module.js';
import { PlatformAdminsService } from './platform-admins.service.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformTenantsService } from './platform-tenants.service.js';
import { platformUserSchema } from './platform-user.schema.js';
import {
  PlatformAdminsController,
  PlatformAuthController,
  PlatformSettingsController,
  PlatformTenantsController,
  PublicPlatformController,
} from './platform.controller.js';

@Module({
  imports: [
    UsersModule,
    OrgsModule,
    MongooseModule.forFeature([{ name: 'PlatformUser', schema: platformUserSchema }]),
  ],
  controllers: [
    PlatformAuthController,
    PlatformAdminsController,
    PlatformTenantsController,
    PlatformSettingsController,
    PublicPlatformController,
  ],
  providers: [PlatformAuthService, PlatformAdminsService, PlatformTenantsService],
  exports: [PlatformAdminsService],
})
export class PlatformModule {}
