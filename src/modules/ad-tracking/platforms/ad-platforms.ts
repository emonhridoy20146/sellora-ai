import { Injectable } from '@nestjs/common';
import type {
  AdEvent,
  AdEventName,
  AdPlatform,
  AdPlatformDescriptor,
  AdSendTarget,
} from '../ad-tracking.types.js';
import { Ga4AdPlatform } from './ga4.platform.js';
import { MetaAdPlatform } from './meta.platform.js';
import { TikTokAdPlatform } from './tiktok.platform.js';

export const GOOGLE_ADS_DESCRIPTOR: AdPlatformDescriptor = {
  key: 'google_ads',
  name: 'Google Ads',
  publicIdLabel: 'Conversion ID',
  publicIdHint: 'Goals › Conversions › your purchase action › Tag setup: the AW- number.',
  publicIdPattern: /^AW-\d{6,15}$/,
  secretLabel: null,
  secretHint: null,
  testCodeLabel: null,
  conversionLabel: true,
  serverEvents: [],
  chatOrders: false,
};

export interface ServerAdPlatform {
  readonly descriptor: AdPlatformDescriptor;
  handles(name: AdEventName): boolean;
  send(target: AdSendTarget, e: AdEvent): Promise<string>;
}

/** The ad platforms, in the order Settings › Ad tracking lists them. */
@Injectable()
export class AdPlatforms {
  constructor(
    readonly meta: MetaAdPlatform,
    readonly tiktok: TikTokAdPlatform,
    readonly ga4: Ga4AdPlatform,
  ) {}

  descriptors(): AdPlatformDescriptor[] {
    return [
      this.meta.descriptor,
      this.tiktok.descriptor,
      this.ga4.descriptor,
      GOOGLE_ADS_DESCRIPTOR,
    ];
  }

  descriptor(key: AdPlatform): AdPlatformDescriptor {
    return this.descriptors().find((d) => d.key === key)!;
  }

  /** The platform's server sender, if it takes server events (Google Ads does not, here). */
  server(key: AdPlatform): ServerAdPlatform | null {
    if (key === 'meta') return this.meta;
    if (key === 'tiktok') return this.tiktok;
    if (key === 'ga4') return this.ga4;
    return null;
  }
}
