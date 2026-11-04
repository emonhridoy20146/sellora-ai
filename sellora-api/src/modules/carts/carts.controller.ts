import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import { normalizePhone } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import {
  OrgScoped,
  RequireAnyPermission,
  RequireModule,
  RequirePermissions,
} from '../auth/decorators.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { CartsService } from './carts.service.js';
import * as dto from './carts.dto.js';

/** Marketing › Abandoned carts for one business (ADR 0018). */
@ApiTags('carts')
@OrgScoped()
@RequireModule('marketing')
@Controller({ path: 'orgs/:orgId/carts', version: '1' })
export class CartsController {
  constructor(
    private readonly carts: CartsService,
    private readonly orgs: OrgsService,
  ) {}

  @Get('settings')
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  @ApiOperation({ summary: 'Whether carts are saved, the reminder steps, previews and prices' })
  settings() {
    return this.carts.getSettings();
  }

  @Patch('settings')
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Turn reminders on or off, set the delays, texts and quiet hours' })
  update(@ZodBody(dto.updateSettingsBody) body: z.infer<typeof dto.updateSettingsBody>) {
    return this.carts.updateSettings(body);
  }

  @Get('summary')
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  @ApiOperation({ summary: 'The last 30 days: carts left, reminded, recovered and the SMS spend' })
  summary() {
    return this.carts.summary();
  }

  @Get()
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  @ApiOperation({ summary: 'Carts by what happened to them, newest first' })
  async list(@ZodQuery(dto.listQuery) q: z.infer<typeof dto.listQuery>) {
    let phone: string | undefined;
    if (q.phone) {
      const org = await this.orgs.get(RequestContext.tenant()!.orgId);
      phone = normalizePhone(q.phone, org.country) ?? undefined;
      if (!phone) throw AppError.validation([{ path: 'phone', message: 'Invalid phone number' }]);
    }
    return this.carts.list({
      view: q.view,
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(phone ? { phone } : {}),
    });
  }

  @Get(':cartId')
  @RequireAnyPermission('marketing.view', 'marketing.manage')
  get(@ZodParam('cartId', dto.cartIdParam) id: string) {
    return this.carts.get(id);
  }

  @Post(':cartId/remind')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Send the next reminder now (at most 3 by hand per cart)' })
  remind(@ZodParam('cartId', dto.cartIdParam) id: string) {
    return this.carts.remindNow(id);
  }

  @Post(':cartId/dismiss')
  @HttpCode(200)
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Stop reminders for this cart' })
  dismiss(@ZodParam('cartId', dto.cartIdParam) id: string) {
    return this.carts.dismiss(id);
  }
}
