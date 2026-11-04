import { Injectable } from '@nestjs/common';
import type { SmsProvider, SmsProviderKey } from '../sms.types.js';
import { AlphaSmsProvider } from './alpha-sms.provider.js';
import { BulkSmsBdProvider } from './bulksmsbd.provider.js';
import { SslWirelessProvider } from './ssl-wireless.provider.js';
import { TwilioProvider } from './twilio.provider.js';

/** The SMS adapters by key. Adding a provider means one adapter and one line here. */
@Injectable()
export class SmsProviders {
  private readonly byKey: Record<SmsProviderKey, SmsProvider>;

  constructor(
    bulksmsbd: BulkSmsBdProvider,
    alpha: AlphaSmsProvider,
    sslWireless: SslWirelessProvider,
    twilio: TwilioProvider,
  ) {
    this.byKey = {
      bulksmsbd: bulksmsbd,
      alpha_sms: alpha,
      ssl_wireless: sslWireless,
      twilio: twilio,
    };
  }

  get(key: SmsProviderKey): SmsProvider {
    return this.byKey[key];
  }

  all(): SmsProvider[] {
    return Object.values(this.byKey);
  }
}

export const SMS_ADAPTERS = [
  BulkSmsBdProvider,
  AlphaSmsProvider,
  SslWirelessProvider,
  TwilioProvider,
  SmsProviders,
];
