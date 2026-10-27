import type { CookieOptions, Request, Response } from 'express';
import { randomToken } from '../../../common/crypto/tokens.js';
import type { AppConfig } from '../../../config/app-config.js';
import type { Realm } from './token.service.js';

export const COOKIE_NAMES: Record<Realm, { access: string; refresh: string; csrf: string }> = {
  merchant: { access: 'sl_at', refresh: 'sl_rt', csrf: 'sl_csrf' },
  platform: { access: 'slp_at', refresh: 'slp_rt', csrf: 'slp_csrf' },
};

const REFRESH_PATH: Record<Realm, string> = { merchant: '/v1/auth', platform: '/v1/platform/auth' };
const ACCESS_PATH: Record<Realm, string> = { merchant: '/', platform: '/v1/platform' };

function base(config: AppConfig, realm: Realm): CookieOptions {
  const domain = config.get('COOKIE_DOMAIN');
  return {
    secure: config.get('COOKIE_SECURE'),
    sameSite: realm === 'platform' ? 'strict' : 'lax',
    ...(domain ? { domain } : {}),
  };
}

export function setAuthCookies(
  res: Response,
  config: AppConfig,
  realm: Realm,
  tokens: {
    accessToken: string;
    accessExpiresIn: number;
    refreshToken: string;
    refreshExpiresAt: Date;
  },
): string {
  const names = COOKIE_NAMES[realm];
  const opts = base(config, realm);
  const csrf = randomToken(24);
  res.cookie(names.access, tokens.accessToken, {
    ...opts,
    httpOnly: true,
    path: ACCESS_PATH[realm],
    maxAge: tokens.accessExpiresIn * 1000,
  });
  res.cookie(names.refresh, tokens.refreshToken, {
    ...opts,
    httpOnly: true,
    path: REFRESH_PATH[realm],
    expires: tokens.refreshExpiresAt,
  });
  res.cookie(names.csrf, csrf, {
    ...opts,
    httpOnly: false,
    path: '/',
    expires: tokens.refreshExpiresAt,
  });
  return csrf;
}

export function clearAuthCookies(res: Response, config: AppConfig, realm: Realm): void {
  const names = COOKIE_NAMES[realm];
  const opts = base(config, realm);
  res.clearCookie(names.access, { ...opts, path: ACCESS_PATH[realm] });
  res.clearCookie(names.refresh, { ...opts, path: REFRESH_PATH[realm] });
  res.clearCookie(names.csrf, { ...opts, path: '/' });
}

export function readCookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value.length > 0 && value.length < 4096 ? value : undefined;
}
