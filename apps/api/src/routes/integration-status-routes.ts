import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { EnvConfig } from '@recoverai/shared';
import { requirePrincipal } from '../auth/principal.js';

export interface IntegrationStatusRoutesOptions {
  env: EnvConfig;
}

function isUnauthorized(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('UNAUTHORIZED:');
}

export const integrationStatusRoutes: FastifyPluginAsync<IntegrationStatusRoutesOptions> = async (
  app: FastifyInstance,
  options,
) => {
  app.get('/status', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const principal = requirePrincipal(req);
      const razorpayConfigured = Boolean(
        options.env.RAZORPAY_KEY_ID &&
        options.env.RAZORPAY_KEY_SECRET &&
        options.env.RAZORPAY_WEBHOOK_SECRET &&
        options.env.RAZORPAY_TEST_MERCHANT_ID === principal.merchantId,
      );

      return reply.send({
        razorpay: {
          mode: 'TEST',
          configured: razorpayConfigured,
          paymentLinksEnabled: razorpayConfigured,
          webhooksConfigured: razorpayConfigured,
        },
        ai: { provider: options.env.AI_PROVIDER ?? 'mock' },
      });
    } catch (error) {
      if (isUnauthorized(error)) return reply.status(401).send({ error: error.message });
      throw error;
    }
  });
};
