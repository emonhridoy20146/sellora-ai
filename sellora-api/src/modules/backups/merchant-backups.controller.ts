import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import {
  AllowSuspendedOrg,
  OrgScoped,
  Public,
  RequirePermissions,
  SignedUrlAuth,
} from '../auth/decorators.js';
import { UsersService } from '../users/users.service.js';
import type { RestorePart } from './backup-rules.js';
import * as dto from './backups.dto.js';
import { MerchantBackupsService } from './merchant-backups.service.js';
import type { Actor } from './schemas.js';

/** Settings › Backups for one business (ADR 0021). */
@ApiTags('backups')
@OrgScoped()
@Controller({ path: 'orgs/:orgId/backups', version: '1' })
export class MerchantBackupsController {
  constructor(
    private readonly backups: MerchantBackupsService,
    private readonly users: UsersService,
  ) {}

  private orgId(): string {
    return RequestContext.tenant()!.orgId;
  }

  /** The signed-in person, as backup records name them. */
  private async by(): Promise<Actor> {
    const id = RequestContext.actor().id;
    const user = await this.users.findById(id);
    return { type: 'user', id, ...(user?.email ? { label: user.email } : {}) };
  }

  @Get()
  // A business whose plan lapsed can still take its data away.
  @AllowSuspendedOrg()
  @RequirePermissions('org.backups.manage')
  @ApiOperation({ summary: 'Downloads, restore points, restores and the Google Drive connection' })
  overview() {
    return this.backups.overview(this.orgId());
  }

  @Post('exports')
  @HttpCode(202)
  @AllowSuspendedOrg()
  @RequirePermissions('org.backups.manage')
  @ApiOperation({ summary: 'Prepare a ZIP of all the business data (CSV and JSON), kept 7 days' })
  async requestExport() {
    return this.backups.requestExport(this.orgId(), await this.by());
  }

  @Post('exports/:id/link')
  @HttpCode(200)
  @AllowSuspendedOrg()
  @RequirePermissions('org.backups.manage')
  @ApiOperation({ summary: 'A 10-minute link to a ready download' })
  exportLink(@ZodParam('id', objectIdSchema) id: string) {
    return this.backups.exportLink(this.orgId(), id);
  }

  @Post('restore-points')
  @HttpCode(202)
  @RequirePermissions('org.backups.manage')
  @ApiOperation({ summary: 'Make a restore point now (the newest 3 are kept)' })
  async restorePoint() {
    return this.backups.makeRestorePoint(this.orgId(), await this.by());
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermissions('org.backups.manage')
  @ApiOperation({ summary: 'What restoring each part from a backup would add, replace and remove' })
  preview(@ZodBody(dto.previewBody) body: z.infer<typeof dto.previewBody>) {
    return this.backups.preview(this.orgId(), body.runId);
  }

  @Post('restores')
  @HttpCode(202)
  @RequirePermissions('org.backups.manage')
  @ApiOperation({
    summary: "Restore chosen parts. Needs the business's name typed and the person's password.",
  })
  restore(@ZodBody(dto.merchantRestoreBody) body: z.infer<typeof dto.merchantRestoreBody>) {
    return this.backups.restore(
      this.orgId(),
      { ...body, parts: body.parts as RestorePart[] },
      { id: RequestContext.actor().id },
    );
  }

  @Post('drive/connect')
  @HttpCode(200)
  @RequirePermissions('org.backups.manage')
  @ApiOperation({ summary: "Google's consent page, to connect the business's Google Drive" })
  connect() {
    return this.backups.connectUrl(this.orgId(), RequestContext.actor().id);
  }

  @Patch('drive')
  @RequirePermissions('org.backups.manage')
  @ApiOperation({ summary: 'Turn the daily Drive copy on or off, or change how many are kept' })
  updateDrive(@ZodBody(dto.driveBody) body: z.infer<typeof dto.driveBody>) {
    return this.backups.updateDrive(this.orgId(), body);
  }

  @Post('drive/copy')
  @HttpCode(202)
  @RequirePermissions('org.backups.manage')
  @ApiOperation({ summary: 'Save a copy to Google Drive now' })
  copyNow() {
    return this.backups.copyNow(this.orgId());
  }

  @Delete('drive')
  @HttpCode(204)
  @AllowSuspendedOrg()
  @RequirePermissions('org.backups.manage')
  @ApiOperation({ summary: "Disconnect Google Drive and revoke Sellora's access at Google" })
  async disconnect(): Promise<void> {
    await this.backups.disconnect(this.orgId());
  }
}

/** The two routes a browser reaches without a session: Google's callback and the ZIP. */
@ApiTags('backups')
@Controller({ path: 'backups', version: '1' })
export class BackupsPublicController {
  constructor(private readonly backups: MerchantBackupsService) {}

  @Get('google/callback')
  @Public()
  @ApiOperation({ summary: "Google's redirect after the consent page (checks the signed state)" })
  async googleCallback(
    @ZodQuery(dto.googleCallbackQuery) q: z.infer<typeof dto.googleCallbackQuery>,
    @Res() res: Response,
  ): Promise<void> {
    const to = await this.backups.callback(q);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, to);
  }

  @Get('exports/:token')
  @SignedUrlAuth()
  @ApiOperation({ summary: 'The ZIP behind a download link' })
  async file(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const file = await this.backups.openExport(token);
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await pipeline(file.body, res);
  }
}
