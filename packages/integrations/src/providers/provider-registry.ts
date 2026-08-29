import { ProviderRegistry as BaseProviderRegistry, IActionProvider } from '@recoverai/core';
import { RazorpayPaymentLinkProvider } from './razorpay-payment-link-provider.js';
import { SimulatedRecoveryProvider } from './simulated-provider.js';

export interface RazorpayTestModeRuntimeConfig {
  enabled: boolean;
  keyId?: string;
  keySecret?: string;
  fetchImpl?: typeof fetch;
}

export class ProviderRegistry extends BaseProviderRegistry {
  constructor(initialProviders?: IActionProvider[]) {
    super(
      initialProviders && initialProviders.length > 0
        ? initialProviders
        : [new SimulatedRecoveryProvider()],
    );
  }

  /** Explicit runtime composition; the no-argument registry remains simulated. */
  static forRuntime(config: RazorpayTestModeRuntimeConfig): ProviderRegistry {
    if (config.enabled) {
      return new ProviderRegistry([
        new RazorpayPaymentLinkProvider({ keyId: config.keyId, keySecret: config.keySecret, fetchImpl: config.fetchImpl }),
      ]);
    }
    return new ProviderRegistry();
  }
}
