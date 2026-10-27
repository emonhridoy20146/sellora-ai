import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { randomToken, sha256 } from '../../../common/crypto/tokens.js';
import type { OneTimePurpose, OneTimeToken } from './one-time-token.schema.js';

@Injectable()
export class OneTimeTokenService {
  constructor(@InjectModel('OneTimeToken') private readonly model: Model<OneTimeToken>) {}

  /** Issues a token and invalidates earlier unused tokens with the same purpose. */
  async issue(
    purpose: OneTimePurpose,
    subjectId: string,
    ttlMs: number,
    data: Record<string, unknown> = {},
  ): Promise<string> {
    const token = randomToken(32);
    const subject = new Types.ObjectId(subjectId);
    await this.model
      .updateMany(
        { subjectId: subject, purpose, usedAt: { $exists: false } },
        { $set: { usedAt: new Date() } },
      )
      .exec();
    await this.model.create({
      purpose,
      subjectId: subject,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + ttlMs),
      data,
    });
    return token;
  }

  /** Atomically marks the token used. Returns null when unknown, used or expired. */
  async consume(
    purpose: OneTimePurpose,
    token: string,
  ): Promise<{ subjectId: string; data: Record<string, unknown> } | null> {
    if (!token || token.length > 200) return null;
    const doc = await this.model
      .findOneAndUpdate(
        {
          tokenHash: sha256(token),
          purpose,
          usedAt: { $exists: false },
          expiresAt: { $gt: new Date() },
        },
        { $set: { usedAt: new Date() } },
        { new: true },
      )
      .lean()
      .exec();
    if (!doc) return null;
    return {
      subjectId: doc.subjectId.toHexString(),
      data: doc.data ?? {},
    };
  }

  /** Validates without consuming (used to show a form before the final submit). */
  async peek(purpose: OneTimePurpose, token: string): Promise<{ subjectId: string } | null> {
    if (!token || token.length > 200) return null;
    const doc = await this.model
      .findOne({
        tokenHash: sha256(token),
        purpose,
        usedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      })
      .lean()
      .exec();
    return doc ? { subjectId: doc.subjectId.toHexString() } : null;
  }
}
