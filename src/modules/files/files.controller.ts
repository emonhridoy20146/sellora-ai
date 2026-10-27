import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam } from '../../common/validation/zod.js';
import { LocalStorageDriver } from '../../infra/storage/local.driver.js';
import { UrlSigner } from '../../infra/storage/signing.js';
import { StorageDriver } from '../../infra/storage/storage.driver.js';
import { OrgScoped, Public, RequireAnyPermission, SignedUrlAuth } from '../auth/decorators.js';
import * as dto from './files.dto.js';
import { FILE_KEY, FilesService, toFileDto } from './files.service.js';

@ApiTags('files')
@OrgScoped()
@Controller({ path: 'orgs/:orgId/files', version: '1' })
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly storage: StorageDriver,
  ) {}

  @Post('uploads')
  @RequireAnyPermission('catalog.manage')
  @ApiOperation({
    summary:
      'Start an upload: reserves storage and returns a short-lived link to PUT the file to. Call complete afterwards.',
  })
  async createUpload(@ZodBody(dto.createUploadBody) body: z.infer<typeof dto.createUploadBody>) {
    const { file, upload } = await this.files.createUpload(body);
    return {
      file: toFileDto(file, this.storage),
      upload: { ...upload, expiresAt: upload.expiresAt.toISOString() },
    };
  }

  @Post(':fileId/complete')
  @HttpCode(200)
  @RequireAnyPermission('catalog.manage')
  @ApiOperation({
    summary: 'Check an upload arrived whole and is a real image, then mark it ready',
  })
  async complete(@ZodParam('fileId', objectIdSchema) id: string) {
    return toFileDto(await this.files.complete(id), this.storage);
  }

  @Get('usage')
  @RequireAnyPermission('catalog.manage', 'billing.view')
  @ApiOperation({ summary: 'Storage used and the plan limit, in bytes (null limit = unlimited)' })
  usage() {
    return this.files.storageUsage();
  }

  @Get(':fileId')
  @RequireAnyPermission('catalog.view', 'catalog.manage')
  async get(@ZodParam('fileId', objectIdSchema) id: string) {
    return toFileDto(await this.files.get(id), this.storage);
  }

  @Delete(':fileId')
  @HttpCode(204)
  @RequireAnyPermission('catalog.manage')
  @ApiOperation({ summary: 'Delete a file nothing uses and give its storage back' })
  async remove(@ZodParam('fileId', objectIdSchema) id: string) {
    await this.files.remove(id);
  }
}

/**
 * Serves stored files and, with the local driver, receives uploads. Public files are
 * cacheable forever (keys never change); private ones need a signed link.
 */
@ApiTags('files')
@Public()
@Controller({ path: 'storage', version: '1' })
export class StorageController {
  constructor(
    private readonly files: FilesService,
    private readonly storage: StorageDriver,
    private readonly signer: UrlSigner,
  ) {}

  @Put('uploads/:token')
  @SignedUrlAuth()
  @HttpCode(204)
  @ApiOperation({ summary: 'Receive an upload (local storage driver only)' })
  async receive(@Param('token') token: string, @Req() req: Request) {
    if (!(this.storage instanceof LocalStorageDriver)) throw new NotFoundException();
    const length = req.headers['content-length'];
    await this.storage.receive(token, req, {
      contentType: req.headers['content-type'],
      contentLength: typeof length === 'string' ? length : undefined,
    });
  }

  @Get('*key')
  @ApiOperation({ summary: 'A stored file' })
  async serve(
    @Param('key') rawKey: string | string[],
    @Query('sig') sig: string | undefined,
    @Res() res: Response,
  ) {
    const key = Array.isArray(rawKey) ? rawKey.join('/') : rawKey;
    if (!FILE_KEY.test(key)) throw AppError.notFound('file');
    const file = await this.files.findReadyByKey(key);
    if (!file) throw AppError.notFound('file');
    if (file.visibility === 'private') {
      const claims = sig ? this.signer.verify<{ k: string; exp: number }>(sig) : null;
      if (claims?.k !== key) throw AppError.notFound('file');
    }
    const object = await this.storage.open(key);
    if (!object) throw AppError.notFound('file');
    res.status(200);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(object.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader(
      'Cache-Control',
      file.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, max-age=300',
    );
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    await pipeline(object.body, res);
  }
}
