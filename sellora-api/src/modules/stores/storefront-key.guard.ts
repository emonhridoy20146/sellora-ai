import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { isIP } from 'node:net';
import { RequestContext } from '../../common/context/request-context.js';
import { safeEqual } from '../../common/crypto/tokens.js';
import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v.trim() : undefined;
}

/**
 * Lets only the storefront app call the shop routes: it sends STOREFRONT_API_KEY in
 * X-Storefront-Key from its own server (shoppers' browsers never see it). Because every
 * call comes from that server, it also passes the shopper's address in X-Shopper-Ip,
 * which rate limits key on instead of the storefront server's own address.
 */
@Injectable()
export class StorefrontKeyGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = this.config.get('STOREFRONT_API_KEY');
    if (!key)
      throw new AppError(
        'storefront_not_configured',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Online stores are not set up on this server.',
      );
    const given = header(req, 'x-storefront-key');
    if (!given || !safeEqual(given, key))
      throw AppError.unauthorized(
        'invalid_storefront_key',
        'The storefront key is missing or wrong.',
      );
    const store = RequestContext.require();
    const shopperIp = header(req, 'x-shopper-ip');
    if (shopperIp && isIP(shopperIp)) store.ip = shopperIp;
    const ua = header(req, 'x-shopper-agent');
    if (ua) store.userAgent = ua.slice(0, 512);
    store.actor = { type: 'visitor', id: 'shopper' };
    return true;
  }
}
