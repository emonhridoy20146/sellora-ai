import { Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppConfig } from '../../config/app-config.js';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { clientIp, userAgent, wantsBodyTokens } from '../../common/http/client-info.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { AuditService } from '../audit/audit.service.js';
import {
  COOKIE_NAMES,
  clearAuthCookies,
  readCookie,
  setAuthCookies,
} from '../auth/core/cookies.js';
import { SessionService, type IssuedTokens } from '../auth/core/session.service.js';
import { PlatformApi, Public, RequirePlatformPermissions } from '../auth/decorators.js';
import { PLATFORM_PERMISSIONS, PLATFORM_ROLE_PERMISSIONS } from '../iam/platform-permissions.js';
import { PlatformAdminsService } from './platform-admins.service.js';
import {
  PlatformAuthService,
  toPlatformUserDto,
  type PlatformUserDoc,
} from './platform-auth.service.js';
import { PlatformSettingsService } from './platform-settings.service.js';
import { PlatformTenantsService } from './platform-tenants.service.js';
import * as dto from './platform.dto.js';

@PlatformApi('auth')
@Controller({ path: 'platform/auth', version: '1' })
export class PlatformAuthController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly sessions: SessionService,
    private readonly config: AppConfig,
  ) {}

  private client(req: Request) {
    return { ip: clientIp(req), userAgent: userAgent(req) };
  }

  private respond(
    req: Request,
    res: Response,
    tokens: IssuedTokens,
    user?: PlatformUserDoc,
    extra: Record<string, unknown> = {},
  ) {
    const body: Record<string, unknown> = {
      status: 'ok',
      accessToken: tokens.accessToken,
      expiresIn: tokens.accessExpiresIn,
      ...extra,
    };
    if (user)
      body.user = {
        ...toPlatformUserDto(user),
        permissions: PLATFORM_ROLE_PERMISSIONS[user.role],
      };
    if (wantsBodyTokens(req)) body.refreshToken = tokens.refreshToken;
    else body.csrfToken = setAuthCookies(res, this.config, 'platform', tokens);
    return body;
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(
    @ZodBody(dto.platformLoginBody) body: z.infer<typeof dto.platformLoginBody>,
    @Req() req: Request,
  ) {
    return this.auth.login(body.email, body.password, this.client(req));
  }

  @Public()
  @Post('login/mfa')
  @HttpCode(200)
  async loginMfa(
    @ZodBody(dto.platformMfaLoginBody) body: z.infer<typeof dto.platformMfaLoginBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { tokens, user } = await this.auth.loginWithMfa(body.mfaToken, body, this.client(req));
    return this.respond(req, res, tokens, user);
  }

  @Public()
  @Post('mfa/setup')
  @HttpCode(200)
  beginMfa(@ZodBody(dto.setupTokenBody) body: z.infer<typeof dto.setupTokenBody>) {
    return this.auth.beginMfaSetup(body.setupToken);
  }

  @Public()
  @Post('mfa/activate')
  @HttpCode(200)
  async activateMfa(
    @ZodBody(dto.completeMfaSetupBody) body: z.infer<typeof dto.completeMfaSetupBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { tokens, user, recoveryCodes } = await this.auth.completeMfaSetup(
      body.setupToken,
      body.code,
      this.client(req),
    );
    return this.respond(req, res, tokens, user, { recoveryCodes });
  }

  @Public()
  @Post('setup/preview')
  @HttpCode(200)
  previewSetup(
    @ZodBody(dto.accountSetupPreviewBody) body: z.infer<typeof dto.accountSetupPreviewBody>,
  ) {
    return this.auth.previewSetup(body.token);
  }

  @Public()
  @Post('setup')
  @HttpCode(200)
  async setup(@ZodBody(dto.accountSetupBody) body: z.infer<typeof dto.accountSetupBody>) {
    await this.auth.completeSetup(body.token, body.password);
    return { ok: true };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @ZodBody(z.object({ refreshToken: z.string().min(20).max(300).optional() }).default({}))
    body: { refreshToken?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = body.refreshToken ?? readCookie(req, COOKIE_NAMES.platform.refresh);
    if (!token) throw AppError.unauthorized('invalid_refresh_token', 'Please sign in again.');
    try {
      return this.respond(req, res, await this.auth.refresh(token, this.client(req)));
    } catch (err) {
      if (err instanceof AppError && err.status === HttpStatus.UNAUTHORIZED)
        clearAuthCookies(res, this.config, 'platform');
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const sid =
      RequestContext.actor().sessionId ??
      readCookie(req, COOKIE_NAMES.platform.refresh)?.split('.')[0];
    if (sid) await this.sessions.revoke(sid, 'logout');
    clearAuthCookies(res, this.config, 'platform');
  }

  @Get('me')
  async me() {
    const user = await this.auth.me(RequestContext.actor().id);
    return {
      ...toPlatformUserDto(user),
      permissions: PLATFORM_ROLE_PERMISSIONS[user.role],
    };
  }
}

@PlatformApi('admins')
@Controller({ path: 'platform/admins', version: '1' })
export class PlatformAdminsController {
  constructor(private readonly admins: PlatformAdminsService) {}

  @Get()
  @RequirePlatformPermissions('platform.admins.view')
  list() {
    return this.admins.list();
  }

  @Get('roles')
  @RequirePlatformPermissions('platform.admins.view')
  roles() {
    return {
      permissions: Object.entries(PLATFORM_PERMISSIONS).map(([key, description]) => ({
        key,
        description,
      })),
      roles: Object.entries(PLATFORM_ROLE_PERMISSIONS).map(([key, permissions]) => ({
        key,
        permissions,
      })),
    };
  }

  @Post()
  @RequirePlatformPermissions('platform.admins.manage')
  invite(@ZodBody(dto.inviteAdminBody) body: z.infer<typeof dto.inviteAdminBody>) {
    return this.admins.invite(body);
  }

  @Patch(':id/role')
  @RequirePlatformPermissions('platform.admins.manage')
  changeRole(
    @ZodParam('id', objectIdSchema) id: string,
    @ZodBody(dto.changeAdminRoleBody) body: z.infer<typeof dto.changeAdminRoleBody>,
  ) {
    return this.admins.changeRole(id, body.role);
  }

  @Patch(':id/status')
  @RequirePlatformPermissions('platform.admins.manage')
  setStatus(
    @ZodParam('id', objectIdSchema) id: string,
    @ZodBody(dto.adminStatusBody) body: z.infer<typeof dto.adminStatusBody>,
  ) {
    return this.admins.setStatus(id, body.status);
  }

  @Post(':id/reset-access')
  @HttpCode(204)
  @RequirePlatformPermissions('platform.admins.manage')
  async resetAccess(@ZodParam('id', objectIdSchema) id: string) {
    await this.admins.resetAccess(id);
  }
}

@PlatformApi('tenants')
@Controller({ path: 'platform', version: '1' })
export class PlatformTenantsController {
  constructor(private readonly tenants: PlatformTenantsService) {}

  @Get('overview')
  @RequirePlatformPermissions('platform.tenants.view')
  overview() {
    return this.tenants.overview();
  }

  @Get('tenants')
  @RequirePlatformPermissions('platform.tenants.view')
  list(@ZodQuery(dto.listQuery) q: z.infer<typeof dto.listQuery>) {
    return this.tenants.listTenants({
      text: q.q,
      status: q.status,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('tenants/:orgId')
  @RequirePlatformPermissions('platform.tenants.view')
  detail(@ZodParam('orgId', objectIdSchema) orgId: string) {
    return this.tenants.tenantDetail(orgId);
  }

  @Patch('tenants/:orgId/status')
  @RequirePlatformPermissions('platform.tenants.manage')
  setStatus(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.tenantStatusBody) body: z.infer<typeof dto.tenantStatusBody>,
  ) {
    return this.tenants.setTenantStatus(orgId, body.status, body.reason, RequestContext.actor().id);
  }

  @Patch('tenants/:orgId/demo')
  @RequirePlatformPermissions('platform.tenants.manage')
  setDemo(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.demoBody) body: z.infer<typeof dto.demoBody>,
  ) {
    return this.tenants.setDemo(orgId, body.hours);
  }

  @Get('users')
  @RequirePlatformPermissions('platform.users.view')
  users(@ZodQuery(dto.listQuery) q: z.infer<typeof dto.listQuery>) {
    return this.tenants.listUsers({
      text: q.q,
      status: q.status,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('users/:userId')
  @RequirePlatformPermissions('platform.users.view')
  user(@ZodParam('userId', objectIdSchema) userId: string) {
    return this.tenants.userDetail(userId);
  }

  @Patch('users/:userId/status')
  @RequirePlatformPermissions('platform.users.manage')
  setUserStatus(
    @ZodParam('userId', objectIdSchema) userId: string,
    @ZodBody(dto.userStatusBody) body: z.infer<typeof dto.userStatusBody>,
  ) {
    return this.tenants.setUserStatus(userId, body.status, body.reason);
  }

  @Post('users/:userId/force-logout')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.users.manage')
  forceLogout(@ZodParam('userId', objectIdSchema) userId: string) {
    return this.tenants.forceLogout(userId);
  }

  @Post('users/:userId/reset-mfa')
  @HttpCode(204)
  @RequirePlatformPermissions('platform.users.security')
  async resetMfa(
    @ZodParam('userId', objectIdSchema) userId: string,
    @ZodBody(dto.reasonBody) body: z.infer<typeof dto.reasonBody>,
  ) {
    await this.tenants.resetUserMfa(userId, body.reason);
  }
}

@PlatformApi('settings')
@Controller({ path: 'platform', version: '1' })
export class PlatformSettingsController {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get('settings')
  @RequirePlatformPermissions('platform.tenants.view')
  get() {
    return this.settings.get();
  }

  @Patch('settings')
  @RequirePlatformPermissions('platform.settings.manage')
  update(@ZodBody(dto.settingsBody) body: z.infer<typeof dto.settingsBody>) {
    return this.settings.update(body, RequestContext.actor().id);
  }

  @Get('audit-events')
  @RequirePlatformPermissions('platform.audit.view')
  async auditEvents(@ZodQuery(dto.platformAuditQuery) q: z.infer<typeof dto.platformAuditQuery>) {
    const page = await this.audit.list(
      { scope: q.scope, orgId: q.orgId, action: q.action, actorId: q.actorId },
      q,
    );
    return {
      items: page.items.map((e) => ({
        id: e._id.toHexString(),
        scope: e.scope,
        seq: e.seq,
        orgId: e.orgId?.toHexString() ?? null,
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

  @Get('audit-events/verify/:scope')
  @RequirePlatformPermissions('platform.audit.view')
  verify(@ZodParam('scope', z.union([z.literal('platform'), objectIdSchema])) scope: string) {
    return this.audit.verifyChain(scope);
  }
}

@Controller({ path: 'public', version: '1' })
export class PublicPlatformController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Public()
  @Get('platform-status')
  async status() {
    const s = await this.settings.get();
    return {
      signupEnabled: s.signupEnabled,
      trial: s.trial,
      maintenance: s.maintenance,
      support: s.support,
    };
  }
}
