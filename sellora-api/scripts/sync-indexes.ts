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
let failed = 0;
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
      try {
        await model.createIndexes();
      } catch (err) {
        // An index with the same key but other options (one that should now be unique)
        // blocks the build. Only `--drop` replaces it, so a failed unique build is a choice.
        if ((err as { code?: number }).code !== 86) throw err;
        failed += 1;
        console.log(`${name}: an index differs from the schema; run with --drop to rebuild it`);
        continue;
      }
      const diff = await model.diffIndexes();
      console.log(
        `${name}: built${diff.toDrop.length ? `, not in schema: ${diff.toDrop.join(', ')}` : ''}`,
      );
    }
  }
} finally {
  await app.close();
}
if (failed) process.exitCode = 1;
