export interface FieldError {
  path: string;
  message: string;
  code?: string;
}

/** An RFC 9457 problem response from the API, or a network failure (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors: FieldError[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static async from(res: Response): Promise<ApiError> {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // Not JSON (a proxy error page, for example).
    }
    const errors = Array.isArray(body.errors) ? (body.errors as FieldError[]) : [];
    return new ApiError(
      res.status,
      typeof body.code === 'string' ? body.code : `http_${res.status}`,
      typeof body.detail === 'string'
        ? body.detail
        : res.status >= 500
          ? 'Something went wrong on our side. Please try again.'
          : 'The request could not be completed.',
      errors,
      typeof body.requestId === 'string' ? body.requestId : undefined,
    );
  }

  static network(): ApiError {
    return new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection.');
  }

  /** Field errors keyed by form field name ("body.email" becomes "email"). */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.errors) {
      const key = e.path.replace(/^(body|query|params)\.?/, '') || '_';
      out[key] ??= e.message;
    }
    return out;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.errors.length > 0 && err.code === 'validation_failed') {
      return err.errors.map((e) => e.message).join(' ');
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
