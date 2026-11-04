import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { AuditService } from '../audit/audit.service.js';
import { OrgScoped, Public, RequirePermissions } from '../auth/decorators.js';
import { PERMISSION_GROUPS } from '../iam/permissions.js';
import { BUSINESS_CATEGORIES } from './business-categories.js';
import { InvitationsService } from './invitations.service.js';
import { MembersService } from './members.service.js';
import * as dto from './orgs.dto.js';
import { OrgsService, toOrgDto } from './orgs.service.js';
import { RolesService } from './roles.service.js';
import { TenantAccessService } from './tenant-access.service.js';

@ApiTags('organizations')
@Controller({ path: 'orgs', version: '1' })
export class OrgsController {
  constructor(
    private readonly orgs: OrgsService,
    private readonly access: TenantAccessService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a business. The caller becomes its owner.' })
  async create(@ZodBody(dto.createOrgBody) body: z.infer<typeof dto.createOrgBody>) {
    const actor = RequestContext.actor();
    const org = await this.orgs.create(actor.id, body);
    return toOrgDto(org, {
      roleKey: 'owner',
      permissions: await this.access.permissionsFor(org._id.toHexString(), 'owner'),
    });
  }

  @Get()
  async list() {
    const actor = RequestContext.actor();
    const items = await this.orgs.listForUser(actor.id);
    return Promise.all(
      items.map(async ({ org, roleKey }) =>
        toOrgDto(org, {
          roleKey,
          permissions: await this.access.permissionsFor(org._id.toHexString(), roleKey),
        }),
      ),
    );
  }

  @Get(':orgId')
  @OrgScoped()
  @RequirePermissions('org.view')
  async get(@Param('orgId') orgId: string) {
    const tenant = RequestContext.tenant()!;
    return toOrgDto(await this.orgs.get(orgId), {
      roleKey: tenant.roleKey!,
      permissions: [...tenant.permissions],
    });
  }

  @Patch(':orgId')
  @OrgScoped()
  @RequirePermissions('org.settings.manage')
  async update(
    @Param('orgId') orgId: string,
    @ZodBody(dto.updateOrgBody) body: z.infer<typeof dto.updateOrgBody>,
  ) {
    const tenant = RequestContext.tenant()!;
    return toOrgDto(await this.orgs.update(orgId, body), {
      roleKey: tenant.roleKey!,
      permissions: [...tenant.permissions],
    });
  }
}

@ApiTags('catalogs')
@Controller({ path: 'catalog', version: '1' })
export class CatalogController {
  @Public()
  @Get('business-categories')
  categories() {
    return Object.entries(BUSINESS_CATEGORIES).map(([key, label]) => ({ key, label }));
  }

  @Public()
  @Get('permissions')
  permissions() {
    return Object.entries(PERMISSION_GROUPS).map(([key, group]) => ({
      key,
      label: group.label,
      permissions: Object.entries(group.permissions).map(([permission, description]) => ({
        key: permission,
        description,
      })),
    }));
  }
}

@ApiTags('staff')
@Controller({ path: 'orgs/:orgId', version: '1' })
@OrgScoped()
export class StaffController {
  constructor(
    private readonly members: MembersService,
    private readonly roles: RolesService,
    private readonly invitations: InvitationsService,
  ) {}

  @Get('members')
  @RequirePermissions('org.members.view')
  listMembers() {
    return this.members.list();
  }

  @Patch('members/:memberId/role')
  @HttpCode(204)
  @RequirePermissions('org.members.manage')
  async changeRole(
    @ZodParam('memberId', objectIdSchema) memberId: string,
    @ZodBody(dto.changeRoleBody) body: z.infer<typeof dto.changeRoleBody>,
  ) {
    await this.members.changeRole(memberId, body.roleKey);
  }

  @Patch('members/:memberId/status')
  @HttpCode(204)
  @RequirePermissions('org.members.manage')
  async setStatus(
    @ZodParam('memberId', objectIdSchema) memberId: string,
    @ZodBody(dto.memberStatusBody) body: z.infer<typeof dto.memberStatusBody>,
  ) {
    await this.members.setStatus(memberId, body.status);
  }

  @Delete('members/:memberId')
  @HttpCode(204)
  @RequirePermissions('org.members.manage')
  async removeMember(@ZodParam('memberId', objectIdSchema) memberId: string) {
    await this.members.remove(memberId);
  }

  @Post('leave')
  @HttpCode(204)
  async leave() {
    await this.members.leave();
  }

  @Post('transfer-ownership')
  @HttpCode(204)
  async transfer(
    @ZodBody(dto.transferOwnershipBody) body: z.infer<typeof dto.transferOwnershipBody>,
  ) {
    await this.members.transferOwnership(body.memberId, body.password);
  }

  @Get('roles')
  @RequirePermissions('org.members.view')
  listRoles() {
    return this.roles.list();
  }

  @Post('roles')
  @RequirePermissions('org.roles.manage')
  createRole(@ZodBody(dto.createRoleBody) body: z.infer<typeof dto.createRoleBody>) {
    return this.roles.create(body);
  }

  @Patch('roles/:roleKey')
  @RequirePermissions('org.roles.manage')
  updateRole(
    @ZodParam('roleKey', z.string().min(2).max(64)) roleKey: string,
    @ZodBody(dto.updateRoleBody) body: z.infer<typeof dto.updateRoleBody>,
  ) {
    return this.roles.update(roleKey, body);
  }

  @Delete('roles/:roleKey')
  @HttpCode(204)
  @RequirePermissions('org.roles.manage')
  async deleteRole(@ZodParam('roleKey', z.string().min(2).max(64)) roleKey: string) {
    await this.roles.remove(roleKey);
  }

  @Get('invitations')
  @RequirePermissions('org.members.view')
  listInvitations() {
    return this.invitations.list();
  }

  @Post('invitations')
  @RequirePermissions('org.members.manage')
  invite(@ZodBody(dto.createInvitationBody) body: z.infer<typeof dto.createInvitationBody>) {
    return this.invitations.create(body.email, body.roleKey);
  }

  @Delete('invitations/:invitationId')
  @HttpCode(204)
  @RequirePermissions('org.members.manage')
  async revokeInvitation(@ZodParam('invitationId', objectIdSchema) id: string) {
    await this.invitations.revoke(id);
  }
}

@ApiTags('staff')
@Controller({ path: 'invitations', version: '1' })
export class InvitationAcceptController {
  constructor(private readonly invitations: InvitationsService) {}

  @Public()
  @Get(':token')
  preview(@ZodParam('token', z.string().min(10).max(200)) token: string) {
    return this.invitations.preview(token);
  }

  @Post('accept')
  @HttpCode(200)
  accept(@ZodBody(dto.acceptInvitationBody) body: z.infer<typeof dto.acceptInvitationBody>) {
    return this.invitations.accept(body.token, RequestContext.actor().id);
  }
}

@ApiTags('audit')
@Controller({ path: 'orgs/:orgId/audit-events', version: '1' })
@OrgScoped()
export class OrgAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('org.audit.view')
  async list(@ZodQuery(dto.auditQuery) q: z.infer<typeof dto.auditQuery>) {
    const tenant = RequestContext.tenant()!;
    const page = await this.audit.list(
      { orgId: tenant.orgId, action: q.action, actorId: q.actorId, from: q.from, to: q.to },
      q,
    );
    return {
      items: page.items.map((e) => ({
        id: e._id.toHexString(),
        seq: e.seq,
        action: e.action,
        outcome: e.outcome,
        actor: e.actor,
        target: e.target ?? null,
        ip: e.ip ?? null,
        metadata: e.metadata,
        at: e.at.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}
