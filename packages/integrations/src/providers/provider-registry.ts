import { ProviderRegistry as BaseProviderRegistry, IActionProvider } from '@recoverai/core';
import { RazorpayPaymentLinkProvider } from './razorpay-payment-link-provider.js';
import { SimulatedRecoveryProvider } from './simulated-provider.js';

export interface RazorpayTestModeRuntimeConfig {
  enabled: boolean;
  keyId?: string;
  keySecret?: string;
  boundMerchantId?: string;
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
      // Base ProviderRegistry chooses the first supporting provider. Keep Razorpay
      // first so payment links use Test Mode, while retaining simulation for all
      // other supported recovery actions.
      return new ProviderRegistry([
        new RazorpayPaymentLinkProvider({ keyId: config.keyId, keySecret: config.keySecret, boundMerchantId: config.boundMerchantId, fetchImpl: config.fetchImpl }),
        new SimulatedRecoveryProvider(),
      ]);
    }
    return new ProviderRegistry();
  }
}
