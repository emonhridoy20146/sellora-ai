import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig, ENV } from './app-config.js';
import { type Env, loadEnv } from './env.js';

@Global()
@Module({})
export class AppConfigModule {
  static forRoot(env?: Env): DynamicModule {
    const resolved = env ?? loadEnv();
    return {
      module: AppConfigModule,
      providers: [
        { provide: ENV, useValue: resolved },
        { provide: AppConfig, useFactory: () => new AppConfig(resolved) },
      ],
      exports: [ENV, AppConfig],
    };
  }
}
