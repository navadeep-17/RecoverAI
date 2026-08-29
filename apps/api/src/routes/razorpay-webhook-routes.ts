import { FastifyPluginAsync } from 'fastify';
import { RazorpayWebhookService } from '@recoverai/integrations';

export interface RazorpayWebhookRoutesOptions { webhookService: RazorpayWebhookService; }

export const razorpayWebhookRoutes: FastifyPluginAsync<RazorpayWebhookRoutesOptions> = async (app, options) => {
  app.post('/razorpay', async (req, reply) => {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.status(400).send({ error: 'Raw webhook body required' });
    }
    const header = req.headers['x-razorpay-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    const result = await options.webhookService.accept(rawBody, signature);
    if (!result.accepted) return reply.status(result.statusCode).send({ error: result.reason });
    return reply.status(202).send({ accepted: true, duplicate: result.duplicate, unsupported: result.unsupported });
  });
};
