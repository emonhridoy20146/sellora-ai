import type { Request } from 'express';

export function clientIp(req: Request): string | undefined {
  return req.ip ?? req.socket.remoteAddress ?? undefined;
}

export function userAgent(req: Request): string | undefined {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 512) : undefined;
}

/** Mobile apps and API clients ask for tokens in the body instead of cookies. */
export function wantsBodyTokens(req: Request): boolean {
  const client = req.headers['x-sellora-client'];
  return client === 'mobile' || client === 'api';
}
