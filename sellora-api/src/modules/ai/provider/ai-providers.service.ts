import { Inject, Injectable } from '@nestjs/common';
import {
  AI_PROVIDERS,
  AiProviderError,
  type AiProvider,
  type AiProviderName,
} from './ai-provider.js';

/** The providers this deployment can call, looked up by the catalogue's provider name. */
@Injectable()
export class AiProviders {
  private readonly byName: Map<AiProviderName, AiProvider>;

  constructor(@Inject(AI_PROVIDERS) providers: AiProvider[]) {
    this.byName = new Map(providers.map((p) => [p.name, p]));
  }

  /** True when `name` is implemented and has credentials. */
  configured(name: AiProviderName): boolean {
    return this.byName.get(name)?.configured() ?? false;
  }

  get(name: AiProviderName): AiProvider {
    const provider = this.byName.get(name);
    if (!provider?.configured())
      throw new AiProviderError('not_configured', `The ${name} AI provider is not set up`);
    return provider;
  }
}
