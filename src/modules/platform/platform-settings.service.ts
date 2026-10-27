import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import type { PlatformSettings } from './platform-user.schema.js';

const ID = 'global';
const CACHE_MS = 10_000;

export interface PlatformSettingsDto {
  signupEnabled: boolean;
  trial: { enabled: boolean; days: number };
  demo: { defaultHours: number };
  maintenance: { enabled: boolean; message: string };
  support: { email: string; whatsapp: string };
  updatedAt: string | null;
}

/** Global switches the super-admin controls: sign-up, free trial, demo length, maintenance. */
@Injectable()
export class PlatformSettingsService {
  private cache?: { at: number; value: PlatformSettingsDto };

  constructor(
    @InjectModel('PlatformSettings') private readonly model: Model<PlatformSettings>,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<PlatformSettingsDto> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const doc = await this.model
      .findOneAndUpdate(
        { _id: ID },
        { $setOnInsert: { _id: ID } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();
    const value: PlatformSettingsDto = {
      signupEnabled: doc.signupEnabled,
      trial: { enabled: doc.trial?.enabled ?? true, days: doc.trial?.days ?? 14 },
      demo: { defaultHours: doc.demo?.defaultHours ?? 72 },
      maintenance: {
        enabled: doc.maintenance?.enabled ?? false,
        message: doc.maintenance?.message ?? '',
      },
      support: { email: doc.support?.email ?? '', whatsapp: doc.support?.whatsapp ?? '' },
      updatedAt: (doc as unknown as { updatedAt?: Date }).updatedAt?.toISOString() ?? null,
    };
    this.cache = { at: Date.now(), value };
    return value;
  }

  async update(
    patch: {
      [K in keyof Omit<PlatformSettingsDto, 'updatedAt'>]?: PlatformSettingsDto[K] extends object
        ? Partial<PlatformSettingsDto[K]>
        : PlatformSettingsDto[K];
    },
    actorId: string,
  ): Promise<PlatformSettingsDto> {
    const before = await this.get();
    const $set: Record<string, unknown> = { updatedBy: actorId };
    const flatten = (prefix: string, obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        if (v && typeof v === 'object' && !Array.isArray(v))
          flatten(`${prefix}${k}.`, v as Record<string, unknown>);
        else $set[`${prefix}${k}`] = v;
      }
    };
    flatten('', patch);
    await this.model.updateOne({ _id: ID }, { $set }, { upsert: true, runValidators: true }).exec();
    this.cache = undefined;
    const after = await this.get();
    await this.audit.record({ action: 'platform.settings.updated', metadata: { before, after } });
    return after;
  }
}
