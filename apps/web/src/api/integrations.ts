import { getJson } from './client';

export interface IntegrationStatus {
  razorpay: {
    mode: 'TEST';
    configured: boolean;
    paymentLinksEnabled: boolean;
    webhooksConfigured: boolean;
  };
  ai: { provider: 'mock' | 'gemini' };
}

export function getIntegrationStatus(): Promise<IntegrationStatus> {
  return getJson<IntegrationStatus>('/integrations/status');
}
