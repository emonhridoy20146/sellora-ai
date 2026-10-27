import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model, type UpdateQuery } from 'mongoose';
import type { WithId } from '../../infra/database/schema-helpers.js';
import type { User } from './user.schema.js';

export type UserDoc = WithId<User>;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  locale: string;
  timezone: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: string;
}

export function toPublicUser(user: UserDoc): PublicUser {
  return {
    id: user._id.toHexString(),
    email: user.email,
    name: user.name,
    phone: user.phone ?? null,
    locale: user.locale,
    timezone: user.timezone,
    emailVerified: Boolean(user.emailVerifiedAt),
    mfaEnabled: Boolean(user.mfa.totpEnabledAt),
    createdAt: user.createdAt.toISOString(),
  };
}

/** Data access for merchant users (global collection, not tenant scoped). */
@Injectable()
export class UsersService {
  constructor(@InjectModel('User') private readonly users: Model<User>) {}

  findById(id: string | Types.ObjectId): Promise<UserDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return this.users.findById(id).lean<UserDoc>().exec();
  }

  findByIds(ids: (string | Types.ObjectId)[]): Promise<UserDoc[]> {
    return this.users
      .find({ _id: { $in: ids.map((i) => new Types.ObjectId(String(i))) } })
      .lean<UserDoc[]>()
      .exec();
  }

  findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.findOne({ email: email.toLowerCase() }).lean<UserDoc>().exec();
  }

  /** Loads the credential fields that are excluded by default. */
  findWithSecrets(filter: { _id?: Types.ObjectId; email?: string }): Promise<UserDoc | null> {
    return this.users
      .findOne(filter)
      .select(
        '+passwordHash +mfa.totpSecretEnc +mfa.totpPendingSecretEnc +mfa.totpLastStep +mfa.recoveryCodes',
      )
      .lean<UserDoc>()
      .exec();
  }

  async create(data: Partial<User>): Promise<UserDoc> {
    const [doc] = await this.users.create([data]);
    return doc!.toObject() as unknown as UserDoc;
  }

  async update(id: string | Types.ObjectId, update: UpdateQuery<User>): Promise<UserDoc | null> {
    return this.users
      .findByIdAndUpdate(id, update, { returnDocument: 'after', runValidators: true })
      .lean<UserDoc>()
      .exec();
  }

  /** Atomic conditional update; returns true when a document matched. */
  async updateWhere(filter: Record<string, unknown>, update: UpdateQuery<User>): Promise<boolean> {
    const res = await this.users.updateOne(filter, update).exec();
    return res.matchedCount === 1;
  }

  async search(q: {
    text?: string;
    status?: string;
    limit: number;
    skip: number;
  }): Promise<{ items: UserDoc[]; total: number }> {
    const filter: Record<string, unknown> = {};
    if (q.text) {
      const escaped = q.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { email: { $regex: escaped, $options: 'i' } },
        { name: { $regex: escaped, $options: 'i' } },
      ];
    }
    if (q.status) filter.status = q.status;
    const [items, total] = await Promise.all([
      this.users
        .find(filter)
        .sort({ _id: -1 })
        .skip(q.skip)
        .limit(q.limit)
        .lean<UserDoc[]>()
        .exec(),
      this.users.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }

  count(filter: Record<string, unknown> = {}): Promise<number> {
    return this.users.countDocuments(filter).exec();
  }
}
