import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersModule } from '../users/users.module.js';
import { InvitationsService } from './invitations.service.js';
import { MembersService } from './members.service.js';
import {
  CatalogController,
  InvitationAcceptController,
  OrgAuditController,
  OrgsController,
  StaffController,
} from './orgs.controller.js';
import { OrgsService } from './orgs.service.js';
import {
  CustomRoleRepository,
  InvitationRepository,
  MembershipRepository,
} from './repositories.js';
import { RolesService } from './roles.service.js';
import {
  customRoleSchema,
  invitationSchema,
  membershipSchema,
  organizationSchema,
} from './schemas.js';
import { TenantAccessService } from './tenant-access.service.js';

@Module({
  imports: [
    UsersModule,
    MongooseModule.forFeature([
      { name: 'Organization', schema: organizationSchema },
      { name: 'Membership', schema: membershipSchema },
      { name: 'CustomRole', schema: customRoleSchema },
      { name: 'Invitation', schema: invitationSchema },
    ]),
  ],
  controllers: [
    OrgsController,
    CatalogController,
    StaffController,
    InvitationAcceptController,
    OrgAuditController,
  ],
  providers: [
    OrgsService,
    TenantAccessService,
    MembersService,
    RolesService,
    InvitationsService,
    MembershipRepository,
    CustomRoleRepository,
    InvitationRepository,
  ],
  exports: [OrgsService, TenantAccessService, MembersService, RolesService, MongooseModule],
})
export class OrgsModule {}
