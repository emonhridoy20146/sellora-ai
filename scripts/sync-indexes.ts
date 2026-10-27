/**
 * Builds every MongoDB index the schemas declare (unique wallet per business, ledger
 * idempotency keys, tenant compound indexes) and drops indexes no schema declares.
 * Run on each deploy when MONGODB_AUTO_INDEX=false (recommended in production, so large
 * index builds never start by surprise when a pod boots).
 * Usage: npm run db:indexes            (build missing, report extra)
 *        npm run db:indexes -- --drop  (also drop indexes no schema declares)
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { AppModule } from '../src/app.module.js';

const drop = process.argv.includes('--drop');
const app = await NestFactory.createApplicationContext(AppModule.forRoot(), {
  logger: ['error', 'warn'],
});
try {
  const connection = app.get<Connection>(getConnectionToken());
  for (const name of connection.modelNames().sort()) {
    const model = connection.model(name);
    if (drop) {
      const dropped = await model.syncIndexes();
      console.log(`${name}: in sync${dropped.length ? `, dropped ${dropped.join(', ')}` : ''}`);
    } else {
      await model.createIndexes();
      const diff = await model.diffIndexes();
      console.log(
        `${name}: built${diff.toDrop.length ? `, not in schema: ${diff.toDrop.join(', ')}` : ''}`,
      );
    }
  }
} finally {
  await app.close();
}
