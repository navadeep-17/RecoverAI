import { AgentDecision } from '@recoverai/shared';

export interface LLMProvider {
  generateStructuredDecision(prompt: string, schema: unknown): Promise<AgentDecision>;
}

export interface PaymentProviderAdapter {
  createPaymentLink(params: { amount: number; currency: string; description: string }): Promise<{ paymentLinkId: string; shortUrl: string }>;
  verifyWebhookSignature(rawPayload: string, signature: string, secret: string): boolean;
}

export interface CommunicationProviderAdapter {
  sendMessage(params: { recipient: string; template: string; variables: Record<string, string> }): Promise<{ messageId: string; status: string }>;
}
