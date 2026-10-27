import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

let replSet: MongoMemoryReplSet | undefined;

/**
 * Starts one throwaway single-node MongoDB replica set (transactions need a replica set)
 * for the whole e2e run. Set TEST_MONGODB_URI to reuse an existing replica set instead.
 * Each test file uses its own database name, so files can run in parallel.
 */
export async function setup(project: TestProject): Promise<void> {
  let uri = process.env.TEST_MONGODB_URI;
  if (!uri) {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      binary: process.env.MONGOMS_SYSTEM_BINARY
        ? { systemBinary: process.env.MONGOMS_SYSTEM_BINARY }
        : {},
    });
    uri = replSet.getUri();
  }
  project.provide('mongoUri', uri);
  project.provide('redisUrl', process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15');
}

export async function teardown(): Promise<void> {
  await replSet?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
    redisUrl: string;
  }
}
