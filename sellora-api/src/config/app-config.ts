import { Injectable } from '@nestjs/common';
import type { Env } from './env.js';

export const ENV = Symbol('ENV');

/**
 * Typed, read-only access to configuration. Inject this instead of reading process.env,
 * so tests can construct the app with an explicit configuration.
 */
@Injectable()
export class AppConfig {
  constructor(private readonly env: Env) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }

  get all(): Readonly<Env> {
    return this.env;
  }
}
