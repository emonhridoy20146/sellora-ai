import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { META_ORG_SCOPED, META_PUBLIC, META_REALM } from '../../src/modules/auth/decorators.js';

export interface RouteInfo {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  isPublic: boolean;
  realm: 'merchant' | 'platform';
  orgScoped: boolean;
  controller: string;
  handler: string;
}

const METHODS: Partial<Record<RequestMethod, RouteInfo['method']>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

function join(...parts: (string | undefined)[]): string {
  return `/${parts
    .filter((p): p is string => Boolean(p))
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')}`;
}

/** Lists every HTTP route with its security metadata, straight from the Nest container. */
export function listRoutes(app: INestApplication): RouteInfo[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const reflector = app.get(Reflector);
  const routes: RouteInfo[] = [];
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const controllerPath = Reflect.getMetadata(PATH_METADATA, metatype) as string | undefined;
    const version = Reflect.getMetadata(VERSION_METADATA, metatype) as string | undefined;
    const proto = Object.getPrototypeOf(instance) as object;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = (proto as Record<string, unknown>)[name] as (...args: unknown[]) => unknown;
      const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (methodPath === undefined || requestMethod === undefined) continue;
      const method = METHODS[requestMethod];
      if (!method) continue;
      const targets = [handler, metatype];
      routes.push({
        method,
        path: join(version ? `v${version}` : undefined, controllerPath, methodPath),
        isPublic: reflector.getAllAndOverride<boolean>(META_PUBLIC, targets) === true,
        realm:
          reflector.getAllAndOverride<'merchant' | 'platform'>(META_REALM, targets) ?? 'merchant',
        orgScoped: reflector.getAllAndOverride<boolean>(META_ORG_SCOPED, targets) === true,
        controller: metatype.name,
        handler: name,
      });
    }
  }
  return routes;
}

/** Replaces :params with plausible values so requests reach the guard. */
export function fillParams(path: string, values: Record<string, string> = {}): string {
  return path.replace(/:(\w+)/g, (_, name: string) => values[name] ?? '0123456789abcdef01234567');
}
