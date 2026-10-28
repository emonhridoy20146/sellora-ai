import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { LandingPage, LandingPageStat, LandingPageVersion } from './schemas.js';

@Injectable()
export class LandingPageRepository extends TenantScopedRepository<LandingPage> {
  constructor(@InjectModel('LandingPage') model: Model<LandingPage>) {
    super(model);
  }
}

@Injectable()
export class LandingPageVersionRepository extends TenantScopedRepository<LandingPageVersion> {
  constructor(@InjectModel('LandingPageVersion') model: Model<LandingPageVersion>) {
    super(model);
  }
}

@Injectable()
export class LandingPageStatRepository extends TenantScopedRepository<LandingPageStat> {
  constructor(@InjectModel('LandingPageStat') model: Model<LandingPageStat>) {
    super(model);
  }
}
