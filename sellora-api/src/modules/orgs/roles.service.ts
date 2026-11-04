import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { slugify } from '../../common/utils/slug.js';
import { AuditService } from '../audit/audit.service.js';
import { OWNER_ROLE_KEY, SYSTEM_ROLES, isPermission, systemRole } from '../iam/permissions.js';
import { CustomRoleRepository, MembershipRepository } from './repositories.js';
import { TenantAccessService } from './tenant-access.service.js';

export interface RoleDto {
  key: string;
  name: string;
  description: string;
  permissions: string[];
  system: boolean;
  memberCount?: number;
}

/** True when every permission in `wanted` is held by the actor. */
export function holdsAll(actorPermissions: ReadonlySet<string>, wanted: Iterable<string>): boolean {
  if (actorPermissions.has('*')) return true;
  for (const p of wanted) if (!actorPermissions.has(p)) return false;
  return true;
}

/**
 * System roles plus per-business custom roles. Anti-escalation rule: nobody can create,
 * edit or assign a role that has a permission they do not hold themselves.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly roles: CustomRoleRepository,
    private readonly members: MembershipRepository,
    private readonly access: TenantAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<RoleDto[]> {
    const [custom, counts] = await Promise.all([
      this.roles.find({}, { sort: { name: 1 } }),
      this.members.aggregate<{ _id: string; n: number }>([
        { $match: { status: 'active' } },
        { $group: { _id: '$roleKey', n: { $sum: 1 } } },
      ]),
    ]);
    const countByKey = new Map(counts.map((c) => [c._id, c.n]));
    return [
      ...SYSTEM_ROLES.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        permissions: [...r.permissions],
        system: true,
        memberCount: countByKey.get(r.key) ?? 0,
      })),
      ...custom.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        permissions: [...r.permissions],
        system: false,
        memberCount: countByKey.get(r.key) ?? 0,
      })),
    ];
  }

  async resolve(roleKey: string): Promise<RoleDto | null> {
    const sys = systemRole(roleKey);
    if (sys)
      return {
        key: sys.key,
        name: sys.name,
        description: sys.description,
        permissions: [...sys.permissions],
        system: true,
      };
    const custom = await this.roles.findOne({ key: roleKey });
    return custom
      ? {
          key: custom.key,
          name: custom.name,
          description: custom.description,
          permissions: [...custom.permissions],
          system: false,
        }
      : null;
  }

  private validatePermissions(permissions: string[]): string[] {
    const unique = [...new Set(permissions)];
    const invalid = unique.filter((p) => !isPermission(p));
    if (invalid.length)
      throw AppError.validation(
        invalid.map((p) => ({ path: 'permissions', message: `Unknown permission ${p}` })),
      );
    const tenant = RequestContext.tenant()!;
    if (!holdsAll(tenant.permissions, unique)) {
      throw AppError.forbidden(
        'permission_escalation',
        'You cannot grant permissions you do not have.',
      );
    }
    return unique.sort();
  }

  async create(input: {
    name: string;
    description?: string;
    permissions: string[];
  }): Promise<RoleDto> {
    const permissions = this.validatePermissions(input.permissions);
    if ((await this.roles.count()) >= 50)
      throw AppError.unprocessable(
        'role_limit_reached',
        'A business can have at most 50 custom roles.',
      );
    let key = `custom-${slugify(input.name, 30, 1)}`;
    if (systemRole(key) || (await this.roles.exists({ key })))
      key = `${key}-${Date.now().toString(36).slice(-4)}`;
    const actor = RequestContext.actor();
    const role = await this.roles.create({
      key,
      name: input.name,
      description: input.description ?? '',
      permissions,
      createdBy: actor.id as never,
    });
    await this.audit.record({
      action: 'role.created',
      orgId: RequestContext.tenant()!.orgId,
      target: { type: 'role', id: key, label: input.name },
      metadata: { permissions },
    });
    return {
      key: role.key,
      name: role.name,
      description: role.description,
      permissions: [...role.permissions],
      system: false,
    };
  }

  async update(
    key: string,
    input: { name?: string; description?: string; permissions?: string[] },
  ): Promise<RoleDto> {
    if (systemRole(key))
      throw AppError.forbidden('system_role_readonly', 'Built-in roles cannot be edited.');
    const existing = await this.roles.findOne({ key });
    if (!existing) throw AppError.notFound('role');
    const tenant = RequestContext.tenant()!;
    // Editing a role that already holds more than you would let you strip or reshape it.
    if (!holdsAll(tenant.permissions, existing.permissions))
      throw AppError.forbidden(
        'permission_escalation',
        'You cannot edit a role with permissions you do not have.',
      );
    const $set: Record<string, unknown> = {};
    if (input.name !== undefined) $set.name = input.name;
    if (input.description !== undefined) $set.description = input.description;
    if (input.permissions !== undefined)
      $set.permissions = this.validatePermissions(input.permissions);
    const updated = await this.roles.findOneAndUpdate({ key }, { $set });
    await this.access.invalidate(tenant.orgId);
    await this.audit.record({
      action: 'role.updated',
      orgId: tenant.orgId,
      target: { type: 'role', id: key, label: updated!.name },
      metadata: { before: existing.permissions, after: updated!.permissions },
    });
    return {
      key,
      name: updated!.name,
      description: updated!.description,
      permissions: [...updated!.permissions],
      system: false,
    };
  }

  async remove(key: string): Promise<void> {
    if (systemRole(key) || key === OWNER_ROLE_KEY)
      throw AppError.forbidden('system_role_readonly', 'Built-in roles cannot be deleted.');
    const existing = await this.roles.findOne({ key });
    if (!existing) throw AppError.notFound('role');
    const tenant = RequestContext.tenant()!;
    if (!holdsAll(tenant.permissions, existing.permissions))
      throw AppError.forbidden(
        'permission_escalation',
        'You cannot delete a role with permissions you do not have.',
      );
    const inUse = await this.members.count({ roleKey: key });
    if (inUse > 0)
      throw AppError.conflict(
        'role_in_use',
        `${inUse} staff member(s) still have this role. Move them to another role first.`,
      );
    await this.roles.deleteOne({ key });
    await this.access.invalidate(tenant.orgId);
    await this.audit.record({
      action: 'role.deleted',
      orgId: tenant.orgId,
      target: { type: 'role', id: key, label: existing.name },
    });
  }
}
