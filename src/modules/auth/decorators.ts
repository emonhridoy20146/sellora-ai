import { SetMetadata, applyDecorators, createParamDecorator } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  RequestContext,
  type Actor,
  type TenantScope,
} from '../../common/context/request-context.js';
import type { Permission } from '../iam/permissions.js';
import type { PlatformPermission } from '../iam/platform-permissions.js';
import type { FeatureModule } from '../billing/feature-modules.js';

export const META_PUBLIC = 'auth:public';
export const META_REALM = 'auth:realm';
export const META_ORG_SCOPED = 'tenant:scoped';
export const META_ALLOW_SUSPENDED = 'tenant:allowSuspended';
export const META_PERMISSIONS = 'auth:permissions';
export const META_ANY_PERMISSIONS = 'auth:anyPermissions';
export const META_PLATFORM_PERMISSIONS = 'auth:platformPermissions';
export const META_REQUIRE_VERIFIED = 'auth:requireVerifiedEmail';
export const META_MODULES = 'billing:modules';

/** No authentication required (an access token is still read if present). */
export const Public = () => SetMetadata(META_PUBLIC, true);

/** Routes for the super-admin realm: platform tokens only, merchant tokens rejected. */
export const PlatformApi = (tag: string) =>
  applyDecorators(
    SetMetadata(META_REALM, 'platform'),
    ApiTags(`platform: ${tag}`),
    ApiCookieAuth('platform-cookie'),
    ApiBearerAuth(),
  );

/**
 * Tenant routes: the path must contain :orgId. The guard checks membership, loads the
 * member's permissions and pins every repository query to this tenant.
 */
export const OrgScoped = () =>
  applyDecorators(
    SetMetadata(META_ORG_SCOPED, true),
    ApiParam({ name: 'orgId', description: 'Business id' }),
    ApiCookieAuth('cookie'),
    ApiBearerAuth(),
  );

/** Lets owners reach billing and data export while the business is suspended. */
export const AllowSuspendedOrg = () => SetMetadata(META_ALLOW_SUSPENDED, true);

/** All listed permissions are required. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(META_PERMISSIONS, permissions);

/** At least one of the listed permissions is required. */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  SetMetadata(META_ANY_PERMISSIONS, permissions);

export const RequirePlatformPermissions = (...permissions: PlatformPermission[]) =>
  SetMetadata(META_PLATFORM_PERMISSIONS, permissions);

export const RequireVerifiedEmail = () => SetMetadata(META_REQUIRE_VERIFIED, true);

/**
 * The route belongs to a paid feature module. The guard answers 402 `module_not_in_plan`
 * when the business's plan does not include every listed module.
 */
export const RequireModule = (...modules: FeatureModule[]) => SetMetadata(META_MODULES, modules);

export const CurrentActor = createParamDecorator((): Actor => RequestContext.actor());

export const CurrentTenant = createParamDecorator((): TenantScope => {
  const tenant = RequestContext.tenant();
  if (!tenant) throw new Error('CurrentTenant used on a route without @OrgScoped()');
  return tenant;
});
