import { Controller, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { PlatformApi, RequirePlatformPermissions, SignedUrlAuth } from '../auth/decorators.js';
import { PlatformAuthService } from '../platform/platform-auth.service.js';
import { BackupKeys, OffsiteStorage } from './backup-keys.js';
import { RESTORE_PART_KEYS, RESTORE_PARTS, type RestorePart } from './backup-rules.js';
import { BackupsService } from './backups.service.js';
import * as dto from './backups.dto.js';
import type { Actor } from './schemas.js';

/** Admin › Backups (ADR 0020): platform backups, and backups and restores of one business. */
@PlatformApi('backups')
@Controller({ path: 'platform/backups', version: '1' })
export class PlatformBackupsController {
  constructor(
    private readonly backups: BackupsService,
    private readonly auth: PlatformAuthService,
    private readonly keys: BackupKeys,
    private readonly offsite: OffsiteStorage,
  ) {}

  /** The signed-in admin, as backup records name them. */
  private async by(): Promise<Actor> {
    const id = RequestContext.actor().id;
    const user = await this.auth.me(id);
    return { type: 'platform', id, label: user.email };
  }

  @Get('settings')
  @RequirePlatformPermissions('platform.backups.manage')
  @ApiOperation({ summary: 'Nightly backup settings, the key in use and the off-site copy' })
  async settings() {
    const s = await this.backups.settings();
    return {
      enabled: s.enabled,
      hour: s.hour,
      timezone: s.timezone,
      keep: s.keep,
      keyId: this.keys.active.kid,
      offsiteConfigured: Boolean(this.offsite.driver),
      parts: RESTORE_PART_KEYS.map((p) => ({
        part: p,
        label: RESTORE_PARTS[p].label,
        collections: RESTORE_PARTS[p].collections,
      })),
    };
  }

  @Patch('settings')
  @RequirePlatformPermissions('platform.backups.manage')
  @ApiOperation({
    summary: 'Change the nightly time, turn backups on or off, or change how many are kept',
  })
  async updateSettings(@ZodBody(dto.settingsBody) body: z.infer<typeof dto.settingsBody>) {
    await this.backups.updateSettings({
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.hour !== undefined ? { hour: body.hour } : {}),
      ...(body.timezone ? { timezone: body.timezone } : {}),
      ...(body.keep
        ? { keep: body.keep as { daily: number; weekly: number; monthly: number } }
        : {}),
    });
    return this.settings();
  }

  @Get('runs')
  @RequirePlatformPermissions('platform.backups.manage')
  @ApiOperation({ summary: 'Backups, newest first' })
  runs(@ZodQuery(dto.runsQuery) q: z.infer<typeof dto.runsQuery>) {
    return this.backups.list({
      limit: q.limit,
      ...(q.scope ? { scope: q.scope } : {}),
      ...(q.orgId ? { orgId: q.orgId } : {}),
    });
  }

  @Post('runs')
  @HttpCode(202)
  @RequirePlatformPermissions('platform.backups.manage')
  @ApiOperation({ summary: 'Back up the whole platform now (the worker makes the file)' })
  async backUpNow() {
    return this.backups.request({ by: await this.by() });
  }

  @Get('runs/:id')
  @RequirePlatformPermissions('platform.backups.manage')
  run(@ZodParam('id', objectIdSchema) id: string) {
    return this.backups.require(id);
  }

  @Post('runs/:id/test-restore')
  @HttpCode(202)
  @RequirePlatformPermissions('platform.backups.manage')
  @ApiOperation({ summary: 'Load a verified backup into a temporary database and compare it' })
  testRestore(@ZodParam('id', objectIdSchema) id: string) {
    return this.backups.requestTestRestore(id);
  }

  @Post('runs/:id/download')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.backups.manage')
  @ApiOperation({
    summary: 'A one-time, five-minute link to the encrypted file. Needs a fresh 2-step code.',
  })
  async download(
    @ZodParam('id', objectIdSchema) id: string,
    @ZodBody(dto.downloadBody) body: z.infer<typeof dto.downloadBody>,
  ) {
    await this.auth.confirmCode(RequestContext.actor().id, body.code);
    return this.backups.downloadLink(id, body.reason);
  }

  @Get('downloads/:token')
  @SignedUrlAuth()
  @ApiOperation({ summary: 'The file behind a download link (works once)' })
  async file(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const file = await this.backups.openDownload(token);
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await pipeline(file.body, res);
  }

  @Get('tenants/:orgId')
  @RequirePlatformPermissions('platform.backups.manage')
  @ApiOperation({ summary: "Backups that hold one business, and that business's restores" })
  async tenant(@ZodParam('orgId', objectIdSchema) orgId: string) {
    const [points, restores] = await Promise.all([
      this.backups.pointsFor(orgId),
      this.backups.restoresFor(orgId),
    ]);
    return { points, restores };
  }

  @Post('tenants/:orgId/runs')
  @HttpCode(202)
  @RequirePlatformPermissions('platform.backups.manage')
  @ApiOperation({ summary: 'Back up one business now' })
  async backUpTenant(@ZodParam('orgId', objectIdSchema) orgId: string) {
    return this.backups.request({ orgId, by: await this.by() });
  }

  @Post('tenants/:orgId/preview')
  @HttpCode(200)
  @RequirePlatformPermissions('platform.backups.manage')
  @ApiOperation({ summary: 'What restoring each part from a backup would add, replace and remove' })
  preview(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.previewBody) body: z.infer<typeof dto.previewBody>,
  ) {
    return this.backups.preview(orgId, body.runId);
  }

  @Post('tenants/:orgId/restores')
  @HttpCode(202)
  @RequirePlatformPermissions('platform.backups.manage')
  @ApiOperation({
    summary:
      "Restore chosen parts of one business. Needs the business's name typed and a fresh 2-step code.",
  })
  async restore(
    @ZodParam('orgId', objectIdSchema) orgId: string,
    @ZodBody(dto.restoreBody) body: z.infer<typeof dto.restoreBody>,
  ) {
    await this.auth.confirmCode(RequestContext.actor().id, body.code);
    return this.backups.requestRestore(
      orgId,
      body.runId,
      { parts: body.parts as RestorePart[], reason: body.reason, confirmName: body.confirmName },
      await this.by(),
    );
  }
}
