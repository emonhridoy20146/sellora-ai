import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.js';
import { REDIS } from '../redis/redis.module.js';

/** Socket.IO namespaces: staff apps, and website chat visitors. */
export type RealtimeNamespace = 'agents' | 'webchat';

export interface RealtimeEnvelope {
  ns: RealtimeNamespace;
  /** Rooms to emit to. A socket in several of them gets the event once. */
  rooms: string[];
  event: string;
  data: unknown;
}

/** The Redis pub/sub channel every API instance listens on. */
export function realtimeChannel(config: AppConfig): string {
  return `${config.get('REDIS_KEY_PREFIX')}realtime`;
}

/**
 * Sends live events to connected browsers. Events go through Redis pub/sub so that any
 * process (an API instance, or the worker after an AI reply) can publish, and every API
 * instance delivers them to the sockets it holds.
 *
 * Delivery is best effort: the database is the record, and clients refetch on reconnect.
 * A failed publish is logged and never fails the caller.
 */
@Injectable()
export class RealtimePublisher {
  private readonly logger = new Logger(RealtimePublisher.name);
  private readonly channel: string;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: AppConfig,
  ) {
    this.channel = realtimeChannel(config);
  }

  async publish(envelope: RealtimeEnvelope): Promise<void> {
    if (envelope.rooms.length === 0) return;
    try {
      await this.redis.publish(this.channel, JSON.stringify(envelope));
    } catch (err) {
      this.logger.warn({ err, event: envelope.event }, 'realtime publish failed');
    }
  }
}

@Global()
@Module({ providers: [RealtimePublisher], exports: [RealtimePublisher] })
export class RealtimeModule {}
