import { FastifyPluginAsync } from 'fastify';
import { RazorpayWebhookService } from '@recoverai/integrations';

export interface RazorpayWebhookRoutesOptions { webhookService: RazorpayWebhookService; }

function normalizedHeader(value: string | string[] | undefined): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export const razorpayWebhookRoutes: FastifyPluginAsync<RazorpayWebhookRoutesOptions> = async (app, options) => {
  app.post('/razorpay', async (req, reply) => {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.status(400).send({ error: 'Raw webhook body required' });
    }
    const header = req.headers['x-razorpay-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    const providerEventId = normalizedHeader(req.headers['x-razorpay-event-id']);
    const result = await options.webhookService.accept(rawBody, signature, providerEventId);
    if (!result.accepted) return reply.status(result.statusCode).send({ error: result.reason });
    return reply.status(202).send({ accepted: true, duplicate: result.duplicate, unsupported: result.unsupported });
  });
};
