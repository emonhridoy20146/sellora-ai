import { Injectable } from '@nestjs/common';
import type { CourierKey, CourierProvider } from '../courier.types.js';
import { PathaoProvider } from './pathao.provider.js';
import { RedxProvider } from './redx.provider.js';
import { SteadfastProvider } from './steadfast.provider.js';

/** The courier adapters by key. Adding a courier means one adapter and one line here. */
@Injectable()
export class CourierProviders {
  private readonly byKey: Record<CourierKey, CourierProvider>;

  constructor(steadfast: SteadfastProvider, pathao: PathaoProvider, redx: RedxProvider) {
    this.byKey = { steadfast, pathao, redx };
  }

  get(key: CourierKey): CourierProvider {
    return this.byKey[key];
  }

  all(): CourierProvider[] {
    return Object.values(this.byKey);
  }
}

export const COURIER_ADAPTERS = [SteadfastProvider, PathaoProvider, RedxProvider, CourierProviders];
