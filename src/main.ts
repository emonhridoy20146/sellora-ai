import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp, mountDocs } from './bootstrap/configure-app.js';
import { bootstrapOwnerFromEnv } from './bootstrap/platform-owner.js';
import { AppConfig } from './config/app-config.js';
import { PlatformAdminsService } from './modules/platform/platform-admins.service.js';

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
  await app.listen(config.get('PORT'), config.get('HOST'));
  const logger = app.get(Logger);
  logger.log(`Sellora API listening on ${config.get('HOST')}:${config.get('PORT')}`);
  const ownerEmail = config.get('PLATFORM_BOOTSTRAP_EMAIL');
  if (ownerEmail)
    await bootstrapOwnerFromEnv({
      admins: app.get(PlatformAdminsService),
      email: ownerEmail,
      name: config.get('PLATFORM_BOOTSTRAP_NAME'),
      log: logger,
    }).catch((err: unknown) => logger.error(`Creating the platform owner failed: ${String(err)}`));
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
