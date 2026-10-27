import { Controller, Get, Inject } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import type { Connection } from 'mongoose';
import { REDIS } from '../../infra/redis/redis.module.js';
import { Public } from '../auth/decorators.js';

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @InjectConnection() private readonly mongo: Connection,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: the process is up. Never checks dependencies (avoids restart storms). */
  @Public()
  @Get('live')
  live() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Readiness: MongoDB and Redis answer. Load balancers route traffic only when ready. */
  @Public()
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        const started = Date.now();
        await this.mongo.db!.admin().ping();
        return { mongodb: { status: 'up', latencyMs: Date.now() - started } };
      },
      async (): Promise<HealthIndicatorResult> => {
        const started = Date.now();
        await this.redis.ping();
        return { redis: { status: 'up', latencyMs: Date.now() - started } };
      },
    ]);
  }
}
