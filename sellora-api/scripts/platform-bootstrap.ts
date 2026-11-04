/**
 * Creates the first platform owner (super-admin) and prints a one-time setup link.
 * Usage: npm run platform:bootstrap -- owner@example.com "Owner Name"
 * Refuses to run when any platform account already exists.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { PlatformAdminsService } from '../src/modules/platform/platform-admins.service.js';

const [email, name] = process.argv.slice(2);
if (!email || !name) {
  console.error('Usage: npm run platform:bootstrap -- <email> "<name>"');
  process.exit(1);
}

const app = await NestFactory.createApplicationContext(AppModule.forRoot(), {
  logger: ['error', 'warn'],
});
try {
  const { setupUrl } = await app
    .get(PlatformAdminsService)
    .bootstrapOwner(email.toLowerCase(), name);
  console.log(
    '\nPlatform owner created. Open this link within 24 hours to set a password and two-factor authentication:\n',
  );
  console.log(`  ${setupUrl}\n`);
} finally {
  await app.close();
}
