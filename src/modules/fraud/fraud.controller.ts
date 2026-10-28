import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodBody, ZodQuery } from '../../common/validation/zod.js';
import {
  OrgScoped,
  RequireAnyPermission,
  RequireModule,
  RequirePermissions,
} from '../auth/decorators.js';
import { FraudService } from './fraud.service.js';

const phone = z.string().trim().min(4).max(32);
const checkQuery = z.object({ phone });
const batchBody = z.object({ phones: z.array(phone).min(1).max(100) }).strict();
const settingsBody = z.object({ shareOutcomes: z.boolean() }).strict();

@ApiTags('fraud check')
@OrgScoped()
@RequireModule('fraud')
@Controller({ path: 'orgs/:orgId/fraud-check', version: '1' })
export class FraudController {
  constructor(private readonly fraud: FraudService) {}

  @Get()
  @RequireAnyPermission('orders.view', 'customers.view')
  @ApiOperation({
    summary: "A phone number's delivery record and risk level, with the reasons",
  })
  check(@ZodQuery(checkQuery) q: z.infer<typeof checkQuery>) {
    return this.fraud.check(q.phone);
  }

  @Post('batch')
  @HttpCode(200)
  @RequireAnyPermission('orders.view', 'customers.view')
  @ApiOperation({ summary: 'Risk levels for up to 100 numbers (badges on lists)' })
  batch(@ZodBody(batchBody) body: z.infer<typeof batchBody>) {
    return this.fraud.batch(body.phones);
  }

  @Get('settings')
  @RequireAnyPermission('orders.view', 'customers.view', 'org.settings.manage')
  settings() {
    return this.fraud.settingsDto();
  }

  @Patch('settings')
  @RequirePermissions('org.settings.manage')
  @ApiOperation({
    summary:
      'Share delivery outcomes with the Sellora network (and see its numbers). Stopping deletes what was shared.',
  })
  updateSettings(@ZodBody(settingsBody) body: z.infer<typeof settingsBody>) {
    return this.fraud.updateSettings(body);
  }
}
