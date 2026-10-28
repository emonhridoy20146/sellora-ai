import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { objectIdSchema } from '../../common/validation/schemas.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/validation/zod.js';
import {
  OrgScoped,
  OwnTokenAuth,
  RequireAnyPermission,
  RequireModule,
  RequirePermissions,
} from '../auth/decorators.js';
import { CourierAccountsService } from './courier-accounts.service.js';
import { CourierError } from './courier.types.js';
import { CourierWebhooksService } from './courier-webhooks.service.js';
import * as dto from './couriers.dto.js';
import { ParcelsService } from './parcels.service.js';

@ApiTags('couriers')
@OrgScoped()
@RequireModule('couriers')
@Controller({ path: 'orgs/:orgId/couriers', version: '1' })
export class CourierAccountsController {
  constructor(private readonly accounts: CourierAccountsService) {}

  @Get('providers')
  @RequireAnyPermission('org.integrations.manage', 'orders.manage')
  @ApiOperation({ summary: 'Couriers Sellora can book with, and what each one asks for' })
  providers() {
    return { items: this.accounts.descriptors() };
  }

  @Get('choices')
  @RequireAnyPermission('orders.view', 'orders.manage', 'org.integrations.manage')
  @ApiOperation({ summary: 'Courier accounts staff can book with (nothing secret)' })
  async choices() {
    const accounts = await this.accounts.list();
    return { items: accounts.map((a) => this.accounts.toChoiceDto(a)) };
  }

  @Get('accounts')
  @RequirePermissions('org.integrations.manage')
  async list() {
    return { items: (await this.accounts.list()).map((a) => this.accounts.toDto(a)) };
  }

  @Post('accounts')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({
    summary: 'Connect a courier account. The credentials are checked with the courier first.',
  })
  async create(@ZodBody(dto.createAccountBody) body: z.infer<typeof dto.createAccountBody>) {
    const { account, check } = await this.accounts.create(body);
    return { account: this.accounts.toDto(account), check };
  }

  @Patch('accounts/:accountId')
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Rename, change credentials or settings, turn on or off, make default' })
  async update(
    @ZodParam('accountId', objectIdSchema) id: string,
    @ZodBody(dto.updateAccountBody) body: z.infer<typeof dto.updateAccountBody>,
  ) {
    const { account, check } = await this.accounts.update(id, body);
    return { account: this.accounts.toDto(account), check };
  }

  @Delete('accounts/:accountId')
  @HttpCode(204)
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Remove an account with no parcels on the way' })
  async remove(@ZodParam('accountId', objectIdSchema) id: string): Promise<void> {
    await this.accounts.remove(id);
  }

  @Post('accounts/:accountId/check')
  @HttpCode(200)
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Check the saved credentials with the courier; lists pickup stores' })
  async check(@ZodParam('accountId', objectIdSchema) id: string) {
    const { account, check } = await this.accounts.check(id);
    return { account: this.accounts.toDto(account), check };
  }

  @Post('accounts/:accountId/webhook-secret')
  @HttpCode(200)
  @RequirePermissions('org.integrations.manage')
  @ApiOperation({ summary: 'Make a new webhook secret (paste it into the courier panel again)' })
  async rotateSecret(@ZodParam('accountId', objectIdSchema) id: string) {
    return this.accounts.toDto(await this.accounts.rotateWebhookSecret(id));
  }

  @Get('accounts/:accountId/locations')
  @RequireAnyPermission('orders.manage', 'org.integrations.manage')
  @ApiOperation({ summary: "The courier's cities, zones or areas, for the booking form" })
  async locations(
    @ZodParam('accountId', objectIdSchema) id: string,
    @ZodQuery(dto.locationsQuery) q: z.infer<typeof dto.locationsQuery>,
  ) {
    const account = await this.accounts.get(id);
    const provider = this.accounts.provider(account.provider);
    if (!provider.locations) return { items: [] };
    try {
      const items = await provider.locations(this.accounts.context(account), {
        kind: q.kind,
        ...(q.parent ? { parentId: q.parent } : {}),
        ...(q.q ? { search: q.q } : {}),
      });
      return { items };
    } catch (err) {
      if (err instanceof CourierError) throw new AppError('courier_unavailable', 503, err.message);
      throw err;
    }
  }
}

@ApiTags('couriers')
@OrgScoped()
@RequireModule('couriers')
@Controller({ path: 'orgs/:orgId', version: '1' })
export class ParcelsController {
  constructor(private readonly parcels: ParcelsService) {}

  @Get('orders/:orderId/parcels')
  @RequirePermissions('orders.view')
  @ApiOperation({ summary: "The order's courier bookings, newest first, with tracking" })
  async forOrder(@ZodParam('orderId', objectIdSchema) orderId: string) {
    return { items: (await this.parcels.forOrder(orderId)).map((p) => this.parcels.toDto(p)) };
  }

  @Post('orders/:orderId/parcels')
  @RequirePermissions('orders.manage')
  @ApiOperation({
    summary:
      'Send the order to a courier now. 422 with the courier’s reason when it refuses the booking.',
  })
  async book(
    @ZodParam('orderId', objectIdSchema) orderId: string,
    @ZodBody(dto.bookParcelBody) body: z.infer<typeof dto.bookParcelBody>,
  ) {
    const parcel = await this.parcels.book(orderId, body);
    if (parcel.status === 'failed')
      throw AppError.unprocessable(
        'courier_refused',
        parcel.error ?? 'The courier refused the booking.',
        {
          parcelId: parcel._id.toHexString(),
        },
      );
    return this.parcels.toDto(parcel);
  }

  @Post('parcels/bulk')
  @HttpCode(202)
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'Send many orders to one courier in the background' })
  bulk(@ZodBody(dto.bulkBookBody) body: z.infer<typeof dto.bulkBookBody>) {
    const { orderIds, ...input } = body;
    return this.parcels.bookMany([...new Set(orderIds)], input);
  }

  @Get('parcels/summary')
  @RequirePermissions('orders.view')
  @ApiOperation({ summary: 'Orders by courier status, orders ready to send, cash with couriers' })
  summary() {
    return this.parcels.summary();
  }

  @Get('parcels/:parcelId')
  @RequirePermissions('orders.view')
  async get(@ZodParam('parcelId', objectIdSchema) id: string) {
    return this.parcels.toDto(await this.parcels.get(id));
  }

  @Post('parcels/:parcelId/refresh')
  @HttpCode(200)
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'Ask the courier where the parcel is now' })
  async refresh(@ZodParam('parcelId', objectIdSchema) id: string) {
    return this.parcels.toDto(await this.parcels.refresh(id));
  }

  @Post('parcels/:parcelId/cancel')
  @HttpCode(200)
  @RequirePermissions('orders.manage')
  @ApiOperation({
    summary:
      'Mark a booking cancelled (after cancelling it with the courier) or not booked (after a lost reply)',
  })
  async cancel(
    @ZodParam('parcelId', objectIdSchema) id: string,
    @ZodBody(dto.cancelParcelBody) body: z.infer<typeof dto.cancelParcelBody>,
  ) {
    return this.parcels.toDto(await this.parcels.cancel(id, body.note));
  }

  @Post('parcels/:parcelId/link')
  @HttpCode(200)
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'After a lost reply: the consignment id found in the courier panel' })
  async link(
    @ZodParam('parcelId', objectIdSchema) id: string,
    @ZodBody(dto.linkParcelBody) body: z.infer<typeof dto.linkParcelBody>,
  ) {
    return this.parcels.toDto(await this.parcels.link(id, body));
  }

  @Post('parcels/:parcelId/dismiss')
  @HttpCode(200)
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'Clear the note on a parcel once it has been dealt with' })
  async dismiss(@ZodParam('parcelId', objectIdSchema) id: string) {
    return this.parcels.toDto(await this.parcels.dismiss(id));
  }
}

/** Couriers call this when a parcel moves. The address carries the account's key. */
@ApiTags('webhooks')
@Controller({ path: 'webhooks/couriers', version: '1' })
export class CourierWebhookController {
  constructor(private readonly webhooks: CourierWebhooksService) {}

  @OwnTokenAuth()
  @Post(':key')
  @ApiExcludeEndpoint()
  async receive(
    @ZodParam('key', dto.webhookKey) key: string,
    @Req() req: Request,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const reply = await this.webhooks.receive(key, req.headers, body);
    for (const [name, value] of Object.entries(reply.headers)) res.setHeader(name, value);
    res.status(reply.status).json(reply.body);
  }
}
