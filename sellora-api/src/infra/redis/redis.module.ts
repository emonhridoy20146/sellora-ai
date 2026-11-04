import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.js';

export const REDIS = Symbol('REDIS');

/** Parses redis:// or rediss:// URLs into plain options (used for BullMQ connections). */
export function redisOptionsFromUrl(url: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  tls?: Record<string, never>;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db: Number(u.pathname.replace('/', '') || 0),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new Redis(config.get('REDIS_URL'), {
          keyPrefix: config.get('REDIS_KEY_PREFIX'),
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          lazyConnect: false,
        }),
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
