import { DynamicModule, Module } from '@nestjs/common';
import { coreImports } from './app.module.js';
import type { Env } from './config/env.js';
import { OrgsModule } from './modules/orgs/orgs.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { MailProcessor } from './workers/mail.processor.js';
import { MaintenanceProcessor } from './workers/maintenance.processor.js';

@Module({})
export class WorkerModule {
  static forRoot(env?: Env): DynamicModule {
    return {
      module: WorkerModule,
      imports: [...coreImports(env), UsersModule, OrgsModule],
      providers: [MailProcessor, MaintenanceProcessor],
    };
  }
}
