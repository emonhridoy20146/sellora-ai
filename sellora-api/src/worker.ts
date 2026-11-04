import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log('Sellora worker started');
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
