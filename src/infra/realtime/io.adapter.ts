import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';
import { AppConfig } from '../../config/app-config.js';

/** Socket.IO limits and CORS, read from the app config instead of decorator constants. */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly config: AppConfig,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    return super.createIOServer(port, {
      ...options!,
      path: '/socket.io',
      serveClient: false,
      // Messages go over HTTP; sockets only carry small events and acks.
      maxHttpBufferSize: 64 * 1024,
      cors: { origin: this.config.get('CORS_ORIGINS'), credentials: true },
    });
  }
}
