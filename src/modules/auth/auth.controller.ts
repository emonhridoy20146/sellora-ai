import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppConfig } from '../../config/app-config.js';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { clientIp, userAgent, wantsBodyTokens } from '../../common/http/client-info.js';
import { ApiZodResponse, ZodBody, ZodParam } from '../../common/validation/zod.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { OrgsService, toOrgDto } from '../orgs/orgs.service.js';
import { TenantAccessService } from '../orgs/tenant-access.service.js';
import { toPublicUser, type UserDoc } from '../users/users.service.js';
import * as dto from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { COOKIE_NAMES, clearAuthCookies, readCookie, setAuthCookies } from './core/cookies.js';
import { SessionService, type IssuedTokens } from './core/session.service.js';
import { Public } from './decorators.js';
import { MfaService } from './mfa.service.js';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly orgs: OrgsService,
    private readonly access: TenantAccessService,
    private readonly config: AppConfig,
  ) {}

  private client(req: Request) {
    return { ip: clientIp(req), userAgent: userAgent(req) };
  }

  private respondWithSession(req: Request, res: Response, tokens: IssuedTokens, user?: UserDoc) {
    const body: Record<string, unknown> = {
      status: 'ok',
      accessToken: tokens.accessToken,
      expiresIn: tokens.accessExpiresIn,
    };
    if (user) body.user = toPublicUser(user);
    if (wantsBodyTokens(req)) body.refreshToken = tokens.refreshToken;
    else body.csrfToken = setAuthCookies(res, this.config, 'merchant', tokens);
    return body;
  }

  @Public()
  @Post('signup')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Create an account. Always answers 202 so emails cannot be enumerated.',
  })
  async signup(@ZodBody(dto.signupBody) body: z.infer<typeof dto.signupBody>, @Req() req: Request) {
    await this.auth.signup(body, this.client(req));
    return { message: 'If this email can be used, we sent a verification link to it.' };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@ZodBody(dto.tokenBody) body: z.infer<typeof dto.tokenBody>) {
    await this.auth.verifyEmail(body.token);
    return { verified: true };
  }

  @Public()
  @Post('verify-email/resend')
  @HttpCode(202)
  async resendVerification(@ZodBody(dto.emailBody) body: z.infer<typeof dto.emailBody>) {
    await this.auth.resendVerification(body.email);
    return { message: 'If the account exists and is unverified, we sent a new link.' };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiZodResponse(200, z.union([dto.sessionResponse, dto.mfaRequiredResponse]))
  async login(
    @ZodBody(dto.loginBody) body: z.infer<typeof dto.loginBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body, this.client(req));
    if (result.kind === 'mfa_required')
      return { status: 'mfa_required', mfaToken: result.mfaToken };
    return this.respondWithSession(req, res, result.tokens, result.user);
  }

  @Public()
  @Post('login/mfa')
  @HttpCode(200)
  @ApiZodResponse(200, dto.sessionResponse)
  async loginMfa(
    @ZodBody(dto.mfaLoginBody) body: z.infer<typeof dto.mfaLoginBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { tokens, user } = await this.auth.loginWithMfa(body, this.client(req));
    return this.respondWithSession(req, res, tokens, user);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @ZodBody(dto.refreshBody) body: z.infer<typeof dto.refreshBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = body.refreshToken ?? readCookie(req, COOKIE_NAMES.merchant.refresh);
    if (!token) throw AppError.unauthorized('invalid_refresh_token', 'Please sign in again.');
    try {
      const tokens = await this.auth.refresh(token, this.client(req));
      return this.respondWithSession(req, res, tokens);
    } catch (err) {
      if (err instanceof AppError && err.status === HttpStatus.UNAUTHORIZED)
        clearAuthCookies(res, this.config, 'merchant');
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    let sid = RequestContext.actor().sessionId;
    if (!sid) {
      const refresh = readCookie(req, COOKIE_NAMES.merchant.refresh);
      sid = refresh?.split('.')[0];
    }
    if (sid) await this.auth.logout(sid);
    clearAuthCookies(res, this.config, 'merchant');
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  async forgot(@ZodBody(dto.emailBody) body: z.infer<typeof dto.emailBody>, @Req() req: Request) {
    await this.auth.forgotPassword(body.email, this.client(req));
    return { message: 'If the account exists, we sent a reset link.' };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(200)
  async reset(@ZodBody(dto.resetPasswordBody) body: z.infer<typeof dto.resetPasswordBody>) {
    await this.auth.resetPassword(body.token, body.password);
    return { reset: true };
  }

  @Post('password/change')
  @HttpCode(204)
  async changePassword(
    @ZodBody(dto.changePasswordBody) body: z.infer<typeof dto.changePasswordBody>,
  ) {
    const actor = RequestContext.actor();
    await this.auth.changePassword(
      actor.id,
      body.currentPassword,
      body.newPassword,
      actor.sessionId!,
    );
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user and the businesses they belong to.' })
  async me() {
    const actor = RequestContext.actor();
    const user = await this.auth.me(actor.id);
    const orgs = await this.orgs.listForUser(actor.id);
    const withPermissions = await Promise.all(
      orgs.map(async ({ org, roleKey }) =>
        toOrgDto(org, {
          roleKey,
          permissions: await this.access.permissionsFor(org._id.toHexString(), roleKey),
        }),
      ),
    );
    return { user: toPublicUser(user), organizations: withPermissions };
  }

  @Patch('me')
  async updateMe(@ZodBody(dto.updateProfileBody) body: z.infer<typeof dto.updateProfileBody>) {
    return toPublicUser(await this.auth.updateProfile(RequestContext.actor().id, body));
  }

  @Get('sessions')
  async listSessions() {
    const actor = RequestContext.actor();
    const sessions = await this.sessions.listActive(actor.id, 'merchant');
    return sessions.map((s) => ({
      id: s._id.toHexString(),
      ip: s.ip ?? null,
      userAgent: s.userAgent ?? null,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      current: s._id.toHexString() === actor.sessionId,
    }));
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  async revokeSession(@ZodParam('sessionId', objectIdSchema) sessionId: string) {
    const actor = RequestContext.actor();
    const session = await this.sessions.get(sessionId);
    if (!session || session.realm !== 'merchant' || session.subjectId.toHexString() !== actor.id)
      throw AppError.notFound('session');
    await this.sessions.revoke(sessionId, 'revoked_by_user');
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  async revokeOthers() {
    const actor = RequestContext.actor();
    const revoked = await this.sessions.revokeAll(
      actor.id,
      'merchant',
      'revoked_by_user',
      actor.sessionId,
    );
    return { revoked };
  }

  @Get('mfa')
  async mfaStatus() {
    return this.mfa.status(RequestContext.actor().id);
  }

  @Post('mfa/totp/setup')
  @HttpCode(200)
  async mfaSetup() {
    return this.mfa.setup(RequestContext.actor().id);
  }

  @Post('mfa/totp/enable')
  @HttpCode(200)
  async mfaEnable(@ZodBody(dto.codeBody) body: z.infer<typeof dto.codeBody>) {
    const actor = RequestContext.actor();
    return this.mfa.enable(actor.id, body.code, actor.sessionId!);
  }

  @Post('mfa/totp/disable')
  @HttpCode(204)
  async mfaDisable(@ZodBody(dto.disableMfaBody) body: z.infer<typeof dto.disableMfaBody>) {
    await this.mfa.disable(RequestContext.actor().id, body.password, body);
  }

  @Post('mfa/recovery-codes')
  @HttpCode(200)
  async regenerateCodes(@ZodBody(dto.passwordBody) body: z.infer<typeof dto.passwordBody>) {
    return this.mfa.regenerateRecoveryCodes(RequestContext.actor().id, body.password);
  }
}
