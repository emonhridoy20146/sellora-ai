import { HttpStatus } from '@nestjs/common';

export interface FieldError {
  path: string;
  message: string;
  code?: string;
}

/**
 * The only error type business code should throw for expected failures. The problem
 * details filter turns it into an RFC 9457 response; anything else becomes a 500.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: HttpStatus,
    message: string,
    readonly details?: { errors?: FieldError[]; [key: string]: unknown },
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(code: string, message: string, details?: AppError['details']): AppError {
    return new AppError(code, HttpStatus.BAD_REQUEST, message, details);
  }

  static validation(errors: FieldError[], message = 'The request is invalid.'): AppError {
    return new AppError('validation_failed', HttpStatus.UNPROCESSABLE_ENTITY, message, { errors });
  }

  static unauthorized(code = 'unauthenticated', message = 'Authentication is required.'): AppError {
    return new AppError(code, HttpStatus.UNAUTHORIZED, message);
  }

  static forbidden(
    code = 'forbidden',
    message = 'You do not have access to this resource.',
  ): AppError {
    return new AppError(code, HttpStatus.FORBIDDEN, message);
  }

  static notFound(resource = 'resource', message?: string): AppError {
    return new AppError(
      `${resource}_not_found`,
      HttpStatus.NOT_FOUND,
      message ?? `The ${resource.replace(/_/g, ' ')} was not found.`,
    );
  }

  static conflict(code: string, message: string, details?: AppError['details']): AppError {
    return new AppError(code, HttpStatus.CONFLICT, message, details);
  }

  static tooManyRequests(
    message = 'Too many requests. Try again later.',
    retryAfterSeconds?: number,
  ): AppError {
    return new AppError('rate_limited', HttpStatus.TOO_MANY_REQUESTS, message, {
      retryAfterSeconds,
    });
  }

  static paymentRequired(code: string, message: string, details?: AppError['details']): AppError {
    return new AppError(code, HttpStatus.PAYMENT_REQUIRED, message, details);
  }

  static unprocessable(code: string, message: string, details?: AppError['details']): AppError {
    return new AppError(code, HttpStatus.UNPROCESSABLE_ENTITY, message, details);
  }
}

/** Thrown when code queries tenant data without a tenant filter. Always a bug. */
export class UnscopedQueryError extends Error {
  constructor(model: string, operation: string) {
    super(`Unscoped ${operation} on tenant collection "${model}": orgId filter is required`);
    this.name = 'UnscopedQueryError';
  }
}
