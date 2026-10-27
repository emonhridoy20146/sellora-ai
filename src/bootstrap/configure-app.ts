import { VersioningType, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { RequestContext } from '../common/context/request-context.js';
import { clientIp, userAgent } from '../common/http/client-info.js';
import { AppConfig } from '../config/app-config.js';
import { httpMetricsMiddleware } from '../infra/metrics/metrics.js';
import { RealtimeIoAdapter } from '../infra/realtime/io.adapter.js';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Applies HTTP-level security and plumbing. Shared by main.ts and the e2e test harness so
 * tests exercise exactly the middleware production runs.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfig);
  const http = app.getHttpAdapter().getInstance() as { disable(name: string): void };
  http.disable('x-powered-by');
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS'));
  app.set('query parser', 'simple');

  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    (req as Request & { id: string }).id = requestId;
    res.setHeader('x-request-id', requestId);
    RequestContext.run(
      {
        requestId,
        ip: clientIp(req),
        userAgent: userAgent(req),
        actor: { type: 'anonymous', id: 'anonymous' },
      },
      () => next(),
    );
  });
  app.use(httpMetricsMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: config.isProduction
        ? { maxAge: 63072000, includeSubDomains: true, preload: true }
        : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '256kb', extended: false });
  app.enableCors({
    origin: (origin, cb) => cb(null, !origin || config.get('CORS_ORIGINS').includes(origin)),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-csrf-token',
      'x-request-id',
      'x-sellora-client',
      'idempotency-key',
    ],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });
  app.enableVersioning({ type: VersioningType.URI });
  app.useWebSocketAdapter(new RealtimeIoAdapter(app, config));
  app.enableShutdownHooks();
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Sellora AI API')
    .setDescription(
      'Multi-tenant commerce automation API. Merchant routes live under /v1/orgs/{orgId}; super-admin routes under /v1/platform. Errors use RFC 9457 problem details.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .addCookieAuth('sl_at', { type: 'apiKey', in: 'cookie', name: 'sl_at' }, 'cookie')
    .addCookieAuth('slp_at', { type: 'apiKey', in: 'cookie', name: 'slp_at' }, 'platform-cookie')
    .build();
  return SwaggerModule.createDocument(app, config);
}

export function mountDocs(app: INestApplication): void {
  const document = buildOpenApi(app);
  SwaggerModule.setup('v1/docs', app, document, { jsonDocumentUrl: 'v1/openapi.json' });
}
