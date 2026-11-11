import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import { OrgScoped, RequirePermissions } from '../auth/decorators.js';
import { AdDestinationsService } from './ad-destinations.service.js';
import { AdEventsService } from './ad-events.service.js';
import * as dto from './ad-tracking.dto.js';

/** Settings › Ad tracking: the business's pixels and tags, and what was sent (ADR 0030). */
@ApiTags('ad tracking')
@OrgScoped()
@Controller({ path: 'orgs/:orgId/ad-tracking', version: '1' })
export class AdTrackingController {
  constructor(
    private readonly destinations: AdDestinationsService,
    private readonly events: AdEventsService,
  ) {}

  private async overview() {
    const [list, settings, sites, counts] = await Promise.all([
      this.destinations.list(),
      this.destinations.settings(),
      this.destinations.sites(),
      this.events.weekCounts(),
    ]);
    return {
      platforms: this.destinations.descriptors(),
      destinations: list.map((d) => ({
        ...this.destinations.toDto(d),
        week: counts[d._id.toHexString()] ?? { sent: 0, failed: 0 },
      })),
      settings: { consent: settings.consent },
      sites,
    };
  }

  @Get()
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Tracking ids (nothing secret), the consent setting and the sites' })
  get() {
    return this.overview();
  }

  @Post('destinations')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Add a pixel or tag (a Meta token is checked first)' })
  async create(
    @ZodBody(dto.createDestinationBody) body: z.infer<typeof dto.createDestinationBody>,
  ) {
    return this.destinations.toDto(await this.destinations.create(body));
  }

  @Patch('destinations/:destinationId')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Change a tracking id: its key, where it is used, when it counts' })
  async update(
    @ZodParam('destinationId', objectIdSchema) id: string,
    @ZodBody(dto.updateDestinationBody) body: z.infer<typeof dto.updateDestinationBody>,
  ) {
    return this.destinations.toDto(await this.destinations.update(id, body));
  }

  @Delete('destinations/:destinationId')
  @HttpCode(204)
  @RequirePermissions('org.integrations.manage')
  async remove(@ZodParam('destinationId', objectIdSchema) id: string) {
    await this.destinations.remove(id);
  }

  @Post('destinations/:destinationId/test')
  @HttpCode(200)
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Send a test event now, with the test code' })
  test(@ZodParam('destinationId', objectIdSchema) id: string) {
    return this.events.sendTest(id);
  }

  @Patch('settings')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Ask shoppers before tracking them, or not' })
  async settings(@ZodBody(dto.settingsBody) body: z.infer<typeof dto.settingsBody>) {
    const s = await this.destinations.updateSettings(body);
    return { consent: s.consent };
  }

  @Get('events')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'The latest server events and what the platforms answered' })
  async log(@ZodQuery(dto.logQuery) q: z.infer<typeof dto.logQuery>) {
    return { items: await this.events.recent(q.destinationId, q.limit) };
  }
}
