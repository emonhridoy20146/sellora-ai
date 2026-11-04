import { Injectable, Logger, OnApplicationShutdown, OnModuleInit, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Namespace } from 'socket.io';
import { AppConfig } from '../../config/app-config.js';
import { REDIS } from '../redis/redis.module.js';
import {
  realtimeChannel,
  type RealtimeEnvelope,
  type RealtimeNamespace,
} from './realtime.publisher.js';

/**
 * Listens on the Redis realtime channel and emits each event to the sockets this API
 * instance holds. Gateways register their namespace when Socket.IO starts.
 */
@Injectable()
export class RealtimeRelay implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeRelay.name);
  private readonly namespaces = new Map<RealtimeNamespace, Namespace>();
  private subscriber?: Redis;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: AppConfig,
  ) {}

  register(ns: RealtimeNamespace, namespace: Namespace): void {
    this.namespaces.set(ns, namespace);
  }

  async onModuleInit(): Promise<void> {
    const channel = realtimeChannel(this.config);
    // A subscribed connection cannot run other commands, so it gets its own.
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('message', (ch: string, raw: string) => {
      if (ch === channel) this.deliver(raw);
    });
    await this.subscriber.subscribe(channel);
  }

  private deliver(raw: string): void {
    let envelope: RealtimeEnvelope;
    try {
      envelope = JSON.parse(raw) as RealtimeEnvelope;
    } catch {
      this.logger.warn('dropped a malformed realtime event');
      return;
    }
    const namespace = this.namespaces.get(envelope.ns);
    if (!namespace || envelope.rooms.length === 0) return;
    namespace.to(envelope.rooms).emit(envelope.event, envelope.data);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.subscriber && this.subscriber.status !== 'end')
      await this.subscriber.quit().catch(() => undefined);
  }
}
