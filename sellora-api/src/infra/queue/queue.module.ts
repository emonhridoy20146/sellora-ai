import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { redisOptionsFromUrl } from '../redis/redis.module.js';
import { QUEUES } from './queue.constants.js';

const queueNames = Object.values(QUEUES);

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        connection: {
          ...redisOptionsFromUrl(config.get('REDIS_QUEUE_URL') ?? config.get('REDIS_URL')),
          maxRetriesPerRequest: null,
        },
        prefix: `${config.get('REDIS_KEY_PREFIX')}q`,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 24 * 3600, count: 5_000 },
          removeOnFail: { age: 14 * 24 * 3600 },
        },
      }),
    }),
    BullModule.registerQueue(...queueNames.map((name) => ({ name }))),
  ],
  exports: [BullModule],
})
export class QueueModule {}
