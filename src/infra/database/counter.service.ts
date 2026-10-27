import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

interface CounterDoc {
  _id: string;
  seq: number;
}

/** Monotonic per-key sequences (order numbers, invoice numbers). */
@Injectable()
export class CounterService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async next(key: string, start = 1000): Promise<number> {
    const collection = this.connection.db!.collection<CounterDoc>('counters');
    const res = await collection.findOneAndUpdate(
      { _id: key },
      [{ $set: { seq: { $add: [{ $ifNull: ['$seq', start] }, 1] } } }],
      { upsert: true, returnDocument: 'after' },
    );
    return res!.seq;
  }
}
