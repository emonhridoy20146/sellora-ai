import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodQuery } from '../../common/validation/zod.js';
import { OrgScoped, RequireModule, RequirePermissions } from '../auth/decorators.js';
import { AnalyticsService } from './analytics.service.js';

const isoDate = z.coerce.date();

/** The longest period one request covers. */
const MAX_DAYS = 366;

export const overviewQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from < q.to, { message: '"from" must be before "to"', path: ['from'] })
  .refine((q) => q.to.getTime() - q.from.getTime() <= MAX_DAYS * 86_400_000, {
    message: `At most ${MAX_DAYS} days at a time`,
    path: ['from'],
  });

@ApiTags('analytics')
@OrgScoped()
@RequireModule('analytics')
@RequirePermissions('analytics.view')
@Controller({ path: 'orgs/:orgId/analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'What Sellora did for the business (AI replies, AI orders, recovered carts, risky orders) and first sales and inbox analytics for a period',
  })
  overview(@ZodQuery(overviewQuery) q: z.infer<typeof overviewQuery>) {
    return this.analytics.overview(q);
  }
}
