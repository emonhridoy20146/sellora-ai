import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp, mountDocs } from './bootstrap/configure-app.js';
import { AppConfig } from './config/app-config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(), {
    bufferLogs: true,
    bodyParser: false,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
  configureApp(app);
  const config = app.get(AppConfig);
  if (!config.isProduction) mountDocs(app);
  await app.listen(config.get('PORT'), '0.0.0.0');
  app.get(Logger).log(`Sellora API listening on :${config.get('PORT')}`);
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
