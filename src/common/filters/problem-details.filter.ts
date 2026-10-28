import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, type FieldError } from '../errors/app-error.js';
import { RequestContext } from '../context/request-context.js';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance?: string;
  requestId?: string;
  errors?: FieldError[];
  [key: string]: unknown;
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function zodIssuesToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Converts every error into RFC 9457 problem details. Internal errors never leak stack
 * traces or messages to clients; they are logged with the request id instead.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const problem = this.toProblem(exception);
    problem.instance = req.originalUrl.split('?')[0];
    problem.requestId = RequestContext.current()?.requestId;

    if (problem.status >= 500) {
      this.logger.error({ err: exception, requestId: problem.requestId }, 'Unhandled error');
    }
    if (problem.status === 429 && typeof problem.retryAfterSeconds === 'number') {
      res.setHeader('Retry-After', String(problem.retryAfterSeconds));
    }
    if (res.headersSent) return;
    res.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown): ProblemDetails {
    if (exception instanceof AppError) {
      const { errors, ...rest } = exception.details ?? {};
      // Extra details come first so they can never replace the standard fields.
      return {
        ...rest,
        type: `https://docs.sellora.ai/errors/${exception.code}`,
        title: TITLES[exception.status] ?? 'Error',
        status: exception.status,
        code: exception.code,
        detail: exception.message,
        ...(errors ? { errors } : {}),
      };
    }
    if (exception instanceof ZodError) {
      return {
        type: 'https://docs.sellora.ai/errors/validation_failed',
        title: TITLES[422]!,
        status: 422,
        code: 'validation_failed',
        detail: 'The request is invalid.',
        errors: zodIssuesToFieldErrors(exception),
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : typeof body === 'object' && 'message' in body && typeof body.message === 'string'
            ? body.message
            : exception.message;
      // Framework 400s come from body parsing (SyntaxError) or bad URI encoding; their
      // messages echo parser internals, so they get a fixed description instead.
      if (status === 400) {
        const malformedJson = /JSON|Unexpected|position/i.test(message);
        return {
          type: `https://docs.sellora.ai/errors/${malformedJson ? 'malformed_body' : 'bad_request'}`,
          title: TITLES[400]!,
          status,
          code: malformedJson ? 'malformed_body' : 'bad_request',
          detail: malformedJson
            ? 'The request body is not valid JSON.'
            : 'The request could not be understood.',
        };
      }
      const code =
        status === 404
          ? 'route_not_found'
          : (TITLES[status] ?? 'error').toLowerCase().replace(/\s+/g, '_');
      return {
        type: `https://docs.sellora.ai/errors/${code}`,
        title: TITLES[status] ?? 'Error',
        status,
        code,
        detail:
          status >= 500
            ? 'An unexpected error occurred.'
            : status === 413
              ? 'The request body is too large.'
              : message,
      };
    }
    if (isPayloadTooLarge(exception)) {
      return {
        type: 'https://docs.sellora.ai/errors/payload_too_large',
        title: TITLES[413]!,
        status: 413,
        code: 'payload_too_large',
        detail: 'The request body is too large.',
      };
    }
    if (isMalformedJson(exception)) {
      return {
        type: 'https://docs.sellora.ai/errors/malformed_body',
        title: TITLES[400]!,
        status: 400,
        code: 'malformed_body',
        detail: 'The request body is not valid JSON.',
      };
    }
    if (isDuplicateKey(exception)) {
      return {
        type: 'https://docs.sellora.ai/errors/duplicate',
        title: TITLES[409]!,
        status: 409,
        code: 'duplicate',
        detail: 'A record with the same unique value already exists.',
      };
    }
    return {
      type: 'https://docs.sellora.ai/errors/internal',
      title: TITLES[500]!,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'internal_error',
      detail: 'An unexpected error occurred.',
    };
  }
}

function isPayloadTooLarge(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && (e as { type?: string }).type === 'entity.too.large'
  );
}

function isMalformedJson(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && (e as { type?: string }).type === 'entity.parse.failed'
  );
}

export function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000;
}
