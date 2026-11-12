import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type {
  LandingAbTest,
  LandingPage,
  LandingPageStat,
  LandingPageVersion,
  LandingTemplate,
} from './schemas.js';

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

@Injectable()
export class LandingAbTestRepository extends TenantScopedRepository<LandingAbTest> {
  constructor(@InjectModel('LandingAbTest') model: Model<LandingAbTest>) {
    super(model);
  }
}

@Injectable()
export class LandingTemplateRepository extends TenantScopedRepository<LandingTemplate> {
  constructor(@InjectModel('LandingTemplate') model: Model<LandingTemplate>) {
    super(model);
  }
}
