import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam } from '../../common/validation/zod.js';
import { OrgScoped, RequireModule, RequirePermissions } from '../auth/decorators.js';
import * as dto from './coupons.dto.js';
import { CouponsService } from './coupons.service.js';

/** Coupons: discount codes for the store and landing pages (ADR 0031). */
@ApiTags('coupons')
@OrgScoped()
@RequireModule('commerce')
@Controller({ path: 'orgs/:orgId/coupons', version: '1' })
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @RequirePermissions('marketing.view')
  @ApiOperation({ summary: 'Coupons with how often each was used, and the landing pages' })
  async list() {
    const [list, landingPages] = await Promise.all([
      this.coupons.list(),
      this.coupons.landingPages(),
    ]);
    return { ...list, landingPages };
  }

  @Post()
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Make a coupon' })
  create(@ZodBody(dto.createCouponBody) body: z.infer<typeof dto.createCouponBody>) {
    return this.coupons.create(body);
  }

  @Patch(':couponId')
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Change a coupon, or switch it on or off' })
  update(
    @ZodParam('couponId', objectIdSchema) id: string,
    @ZodBody(dto.updateCouponBody) body: z.infer<typeof dto.updateCouponBody>,
  ) {
    return this.coupons.update(id, body);
  }

  @Delete(':couponId')
  @HttpCode(204)
  @RequirePermissions('marketing.manage')
  @ApiOperation({ summary: 'Remove a coupon no order used' })
  async remove(@ZodParam('couponId', objectIdSchema) id: string): Promise<void> {
    await this.coupons.remove(id);
  }
}
