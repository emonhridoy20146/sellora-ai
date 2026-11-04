import { Module } from '@nestjs/common';
import { OrgsModule } from '../orgs/orgs.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { MfaService } from './mfa.service.js';

@Module({
  imports: [UsersModule, OrgsModule],
  controllers: [AuthController],
  providers: [AuthService, MfaService],
  exports: [AuthService],
})
export class AuthModule {}
