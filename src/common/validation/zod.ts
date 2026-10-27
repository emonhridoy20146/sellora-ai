import {
  ArgumentMetadata,
  Body,
  Injectable,
  Param,
  PipeTransform,
  Query,
  applyDecorators,
} from '@nestjs/common';
import { ApiBody, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { zodIssuesToFieldErrors } from '../filters/problem-details.filter.js';

type JsonSchema = Record<string, unknown>;

const cache = new WeakMap<z.ZodType, { input: JsonSchema; output: JsonSchema }>();

/** Converts a Zod schema to an OpenAPI 3.0 compatible JSON schema. */
export function toOpenApiSchema(schema: z.ZodType, io: 'input' | 'output' = 'input'): JsonSchema {
  let entry = cache.get(schema);
  if (!entry) {
    const convert = (mode: 'input' | 'output') => {
      const json = z.toJSONSchema(schema, {
        target: 'openapi-3.0',
        io: mode,
        unrepresentable: 'any',
      }) as JsonSchema;
      delete json.$schema;
      return json;
    };
    entry = { input: convert('input'), output: convert('output') };
    cache.set(schema, entry);
  }
  return entry[io];
}

@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(
    private readonly schema: T,
    private readonly location: 'body' | 'query' | 'param' = 'body',
  ) {}

  transform(value: unknown, _meta: ArgumentMetadata): z.output<T> {
    const result = this.schema.safeParse(value ?? (this.location === 'body' ? undefined : {}));
    if (!result.success) {
      const errors = zodIssuesToFieldErrors(result.error).map((e) => ({
        ...e,
        path: e.path === '(root)' ? this.location : `${this.location}.${e.path}`,
      }));
      throw AppError.validation(errors);
    }
    return result.data;
  }
}

/** Validates the request body with `schema` and documents it in OpenAPI. */
export function ZodBody<T extends z.ZodType>(schema: T): ParameterDecorator {
  return (target, key, index) => {
    Body(new ZodValidationPipe(schema, 'body'))(target, key, index);
    if (key === undefined) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor) ApiBody({ schema: toOpenApiSchema(schema) })(target, key, descriptor);
  };
}

/** Validates the query string with an object schema and documents each property. */
export function ZodQuery<T extends z.ZodObject>(schema: T): ParameterDecorator {
  return (target, key, index) => {
    Query(new ZodValidationPipe(schema, 'query'))(target, key, index);
    if (key === undefined) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor) return;
    const json = toOpenApiSchema(schema) as {
      properties?: Record<string, JsonSchema>;
      required?: string[];
    };
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      ApiQuery({ name, required: json.required?.includes(name) ?? false, schema: prop })(
        target,
        key,
        descriptor,
      );
    }
  };
}

/** Validates a single route parameter. */
export function ZodParam<T extends z.ZodType>(name: string, schema: T): ParameterDecorator {
  return (target, key, index) => {
    Param(name, new ZodValidationPipe(schema, 'param'))(target, key, index);
    if (key === undefined) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor) ApiParam({ name, schema: toOpenApiSchema(schema) })(target, key, descriptor);
  };
}

/** Documents a response body using a Zod schema. */
export function ApiZodResponse(
  status: number,
  schema: z.ZodType,
  description = 'OK',
): MethodDecorator {
  return applyDecorators(
    ApiResponse({ status, description, schema: toOpenApiSchema(schema, 'output') }),
  );
}
