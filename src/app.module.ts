import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';
import { RequestContext } from './common/context/request-context.js';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { AppConfig } from './config/app-config.js';
import { AppConfigModule } from './config/config.module.js';
import type { Env } from './config/env.js';
import { DatabaseModule } from './infra/database/database.module.js';
import { MailModule } from './infra/mail/mail.module.js';
import { RealtimeModule } from './infra/realtime/realtime.publisher.js';
import { StorageModule } from './infra/storage/storage.module.js';
import { MetricsController } from './infra/metrics/metrics.js';
import { QueueModule } from './infra/queue/queue.module.js';
import { RedisModule } from './infra/redis/redis.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AuthCoreModule } from './modules/auth/core/auth-core.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { CommerceModule } from './modules/commerce/commerce.module.js';
import { CouriersModule } from './modules/couriers/couriers.module.js';
import { FraudModule } from './modules/fraud/fraud.module.js';
import { FilesModule } from './modules/files/files.module.js';
import { InboxModule } from './modules/inbox/inbox.module.js';
import { MetaModule } from './modules/meta/meta.module.js';
import { AccessGuard } from './modules/auth/guards/access.guard.js';
import { HealthModule } from './modules/health/health.module.js';
import { OrgsModule } from './modules/orgs/orgs.module.js';
import { PlatformSettingsModule } from './modules/platform/platform-settings.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { UsersModule } from './modules/users/users.module.js';

/** Infrastructure shared by the HTTP API and the background worker. */
export function coreImports(env?: Env) {
  return [
    AppConfigModule.forRoot(env),
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          genReqId: (req) => (req as unknown as { id: string }).id,
          customProps: () => {
            const ctx = RequestContext.current();
            return {
              actor: ctx?.actor.type === 'anonymous' ? undefined : ctx?.actor.id,
              orgId: ctx?.tenant?.orgId,
            };
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-csrf-token"]',
              'res.headers["set-cookie"]',
              '*.password',
              '*.token',
              '*.refreshToken',
            ],
            censor: '[redacted]',
          },
          autoLogging: {
            ignore: (req) => req.url?.startsWith('/v1/health') === true || req.url === '/metrics',
          },
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url?.split('?')[0],
            }),
          },
        },
      }),
    }),
    EventEmitterModule.forRoot({ wildcard: false, maxListeners: 50 }),
    DatabaseModule,
    RedisModule,
    QueueModule,
    MailModule,
    StorageModule,
    RealtimeModule,
    AuditModule,
    PlatformSettingsModule,
    AuthCoreModule,
  ];
}

@Module({})
export class AppModule {
  static forRoot(env?: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ...coreImports(env),
        HealthModule,
        UsersModule,
        OrgsModule,
        AuthModule,
        PlatformModule,
        BillingModule,
        FilesModule,
        CommerceModule,
        InboxModule,
        AiModule,
        MetaModule,
        CouriersModule,
        FraudModule,
      ],
      controllers: [MetricsController],
      providers: [
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
