import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { AppConfig } from '../../config/app-config.js';
import { AppError } from '../../common/errors/app-error.js';
import { safeEqual } from '../../common/crypto/tokens.js';
import { Public } from '../../modules/auth/decorators.js';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: 'sellora_' });

const httpDuration = new Histogram({
  name: 'sellora_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const authEvents = new Counter({
  name: 'sellora_auth_events_total',
  help: 'Authentication events',
  labelNames: ['realm', 'event'],
  registers: [metricsRegistry],
});

/** Records request latency by route template (not raw URL) to keep cardinality bounded. */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = (req.route as { path?: string } | undefined)?.path;
    end({
      method: req.method,
      route: route ? `${req.baseUrl}${route}` : 'unmatched',
      status: String(res.statusCode),
    });
  });
  next();
}

@ApiExcludeController()
@Controller({ path: 'metrics' })
export class MetricsController {
  constructor(private readonly config: AppConfig) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(@Req() req: Request): Promise<string> {
    const token = this.config.get('METRICS_TOKEN');
    const header = req.headers.authorization ?? '';
    if (!token || !safeEqual(header, `Bearer ${token}`)) throw AppError.notFound('route');
    return metricsRegistry.metrics();
  }
}
