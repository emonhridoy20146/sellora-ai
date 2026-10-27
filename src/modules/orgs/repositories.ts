import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { CustomRole, Invitation, Membership } from './schemas.js';

@Injectable()
export class MembershipRepository extends TenantScopedRepository<Membership> {
  constructor(@InjectModel('Membership') model: Model<Membership>) {
    super(model);
  }
}

@Injectable()
export class CustomRoleRepository extends TenantScopedRepository<CustomRole> {
  constructor(@InjectModel('CustomRole') model: Model<CustomRole>) {
    super(model);
  }
}

@Injectable()
export class InvitationRepository extends TenantScopedRepository<Invitation> {
  constructor(@InjectModel('Invitation') model: Model<Invitation>) {
    super(model);
  }
}
