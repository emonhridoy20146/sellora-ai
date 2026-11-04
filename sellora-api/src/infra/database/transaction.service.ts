import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import mongoose, { type ClientSession, type Connection } from 'mongoose';

/**
 * Runs work inside a MongoDB multi-document transaction. Mongoose's transaction
 * AsyncLocalStorage passes the session to every operation in `fn` automatically, and the
 * driver retries on transient errors, so `fn` must be safe to re-run.
 */
@Injectable()
export class TransactionService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** The session of the transaction this call is already running inside, if any. */
  static activeSession(): ClientSession | undefined {
    const store = (
      mongoose as unknown as {
        transactionAsyncLocalStorage?: { getStore(): { session?: ClientSession } | undefined };
      }
    ).transactionAsyncLocalStorage?.getStore();
    return store?.session;
  }

  /** Joins the surrounding transaction when there is one, otherwise starts a new one. */
  async runOrJoin<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const active = TransactionService.activeSession();
    if (active?.inTransaction()) return fn(active);
    return this.run(fn);
  }

  async run<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.connection.transaction(fn, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });
  }
}
