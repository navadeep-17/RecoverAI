import { ProviderRegistry as BaseProviderRegistry, IActionProvider } from '@recoverai/core';
import { SimulatedRecoveryProvider } from './simulated-provider.js';

export class ProviderRegistry extends BaseProviderRegistry {
  constructor(initialProviders?: IActionProvider[]) {
    super(
      initialProviders && initialProviders.length > 0
        ? initialProviders
        : [new SimulatedRecoveryProvider()],
    );
  }
}

