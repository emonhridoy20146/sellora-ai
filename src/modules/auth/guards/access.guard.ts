import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Types } from 'mongoose';
import { AppConfig } from '../../../config/app-config.js';
import { RequestContext } from '../../../common/context/request-context.js';
import { AppError } from '../../../common/errors/app-error.js';
import { safeEqual } from '../../../common/crypto/tokens.js';
import {
  PLATFORM_ROLES,
  platformRoleHas,
  type PlatformPermission,
  type PlatformRole,
} from '../../iam/platform-permissions.js';
import { TenantAccessService } from '../../orgs/tenant-access.service.js';
import { EntitlementsService } from '../../billing/entitlements.service.js';
import type { FeatureModule } from '../../billing/feature-modules.js';
import { COOKIE_NAMES, readCookie } from '../core/cookies.js';
import { SessionService } from '../core/session.service.js';
import { TokenService, type AccessClaims, type Realm } from '../core/token.service.js';
import {
  META_ALLOW_SUSPENDED,
  META_ANY_PERMISSIONS,
  META_MODULES,
  META_ORG_SCOPED,
  META_PERMISSIONS,
  META_PLATFORM_PERMISSIONS,
  META_PUBLIC,
  META_REALM,
} from '../decorators.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthenticatedRequest extends Request {
  auth?: { claims: AccessClaims; via: 'bearer' | 'cookie' };
}

/**
 * The single global guard. In order it: authenticates (bearer or cookie), enforces CSRF
 * for cookie sessions, resolves tenant membership for @OrgScoped routes, checks merchant
 * or platform permissions, then plan modules (402 when the plan lacks one). Keeping this
 * in one place makes the order explicit.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly tenantAccess: TenantAccessService,
    private readonly entitlements: EntitlementsService,
    private readonly config: AppConfig,
  ) {}

  private meta<T>(key: string, ctx: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const isPublic = this.meta<boolean>(META_PUBLIC, ctx) === true;
    const realm = this.meta<Realm>(META_REALM, ctx) ?? 'merchant';

    await this.authenticate(req, realm, isPublic);
    this.enforceCsrf(req, realm);
    if (isPublic) return true;

    if (realm === 'platform') {
      this.checkPlatformPermissions(ctx);
      return true;
    }
    if (this.meta<boolean>(META_ORG_SCOPED, ctx)) await this.resolveTenant(req, ctx);
    this.checkMerchantPermissions(ctx);
    await this.checkModules(ctx);
    return true;
  }

  private extractToken(
    req: Request,
    realm: Realm,
  ): { token: string; via: 'bearer' | 'cookie' } | undefined {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      if (token) return { token, via: 'bearer' };
    }
    const cookie = readCookie(req, COOKIE_NAMES[realm].access);
    return cookie ? { token: cookie, via: 'cookie' } : undefined;
  }

  private async authenticate(
    req: AuthenticatedRequest,
    realm: Realm,
    isPublic: boolean,
  ): Promise<void> {
    const found = this.extractToken(req, realm);
    if (!found) {
      if (isPublic) return;
      throw AppError.unauthorized();
    }
    let claims: AccessClaims;
    try {
      claims = await this.tokens.verifyAccess(found.token, realm);
    } catch (err) {
      if (isPublic) return;
      throw err;
    }
    if (!(await this.sessions.isActive(claims.sid))) {
      if (isPublic) return;
      throw AppError.unauthorized(
        'session_revoked',
        'This session has ended. Please sign in again.',
      );
    }
    req.auth = { claims, via: found.via };
    RequestContext.setActor({
      type: realm === 'platform' ? 'platform' : 'user',
      id: claims.sub,
      sessionId: claims.sid,
      amr: claims.amr,
      ...(claims.prole ? { platformRole: claims.prole } : {}),
    });
    void this.sessions
      .touch(claims.sid)
      .catch((err: unknown) => this.logger.warn({ err }, 'session touch failed'));
  }

  /**
   * Double-submit cookie check for state-changing requests that rely on cookies. Requests
   * with a bearer token are not exposed to CSRF and skip the check.
   */
  private enforceCsrf(req: AuthenticatedRequest, realm: Realm): void {
    if (SAFE_METHODS.has(req.method)) return;
    if (req.auth?.via === 'bearer') return;
    const names = COOKIE_NAMES[realm];
    const usesCookies = Boolean(readCookie(req, names.access) ?? readCookie(req, names.refresh));
    if (!usesCookies) return;
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !this.config.get('CORS_ORIGINS').includes(origin)) {
      throw AppError.forbidden('origin_not_allowed', 'Request origin is not allowed.');
    }
    const header = req.headers['x-csrf-token'];
    const cookie = readCookie(req, names.csrf);
    if (typeof header !== 'string' || !cookie || !safeEqual(header, cookie)) {
      throw AppError.forbidden(
        'csrf_failed',
        'Security check failed. Refresh the page and try again.',
      );
    }
  }

  private async resolveTenant(req: AuthenticatedRequest, ctx: ExecutionContext): Promise<void> {
    const actor = RequestContext.actor();
    if (actor.type !== 'user') throw AppError.forbidden();
    const orgId = req.params.orgId;
    if (typeof orgId !== 'string' || !Types.ObjectId.isValid(orgId))
      throw AppError.notFound('organization');
    const access = await this.tenantAccess.resolve(orgId.toLowerCase(), actor.id);
    // Not a member and does not exist look the same, so ids cannot be probed.
    if (!access) throw AppError.notFound('organization');
    if (access.orgStatus === 'suspended' && !this.meta<boolean>(META_ALLOW_SUSPENDED, ctx)) {
      throw AppError.forbidden(
        'org_suspended',
        'This business is suspended. Contact support or check billing.',
      );
    }
    if (access.isDemo && access.demoExpiresAt && new Date(access.demoExpiresAt) <= new Date()) {
      throw AppError.forbidden('demo_expired', 'This demo has ended. Choose a plan to keep going.');
    }
    RequestContext.setTenant({
      orgId: access.orgId,
      membershipId: access.membershipId,
      roleKey: access.roleKey,
      permissions: new Set(access.permissions),
    });
  }

  private checkMerchantPermissions(ctx: ExecutionContext): void {
    const all = this.meta<string[]>(META_PERMISSIONS, ctx) ?? [];
    const any = this.meta<string[]>(META_ANY_PERMISSIONS, ctx) ?? [];
    if (all.length === 0 && any.length === 0) return;
    const tenant = RequestContext.tenant();
    if (!tenant) throw new Error('Permission metadata on a route without @OrgScoped()');
    const has = (p: string) => tenant.permissions.has('*') || tenant.permissions.has(p);
    const missing = all.filter((p) => !has(p));
    if (missing.length || (any.length && !any.some(has))) {
      throw new AppError('missing_permission', 403, 'Your role does not allow this action.', {
        required: missing.length ? missing : any,
      });
    }
  }

  private async checkModules(ctx: ExecutionContext): Promise<void> {
    const modules = this.meta<FeatureModule[]>(META_MODULES, ctx) ?? [];
    if (modules.length === 0) return;
    const tenant = RequestContext.tenant();
    if (!tenant) throw new Error('@RequireModule on a route without @OrgScoped()');
    await this.entitlements.assertModules(tenant.orgId, modules);
  }

  private checkPlatformPermissions(ctx: ExecutionContext): void {
    const actor = RequestContext.actor();
    if (actor.type !== 'platform') throw AppError.unauthorized();
    const required = this.meta<PlatformPermission[]>(META_PLATFORM_PERMISSIONS, ctx) ?? [];
    const role = actor.platformRole as PlatformRole | undefined;
    if (!role || !PLATFORM_ROLES.includes(role)) throw AppError.forbidden();
    const missing = required.filter((p) => !platformRoleHas(role, p));
    if (missing.length)
      throw new AppError(
        'missing_permission',
        403,
        'Your platform role does not allow this action.',
        { required: missing },
      );
  }
}
