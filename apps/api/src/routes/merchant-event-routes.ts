import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { EventIngestionService, OutcomeObserver } from '@recoverai/core';
import { MerchantEventNormalizer } from '@recoverai/integrations';
import { NormalizedEventType } from '@recoverai/shared';
import { requirePrincipal } from '../auth/principal.js';

const safeString = z.string().trim().min(1).max(256);
const safeMetadata = z.record(z.union([z.string().max(256), z.number(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 20, 'Metadata has too many fields')
  .refine((value) => Object.keys(value).every((key) => !/(secret|token|password|credential|api.?key|authorization)/i.test(key)), 'Metadata contains a sensitive key');
const customerSchema = z.object({
  externalCustomerId: safeString,
  email: z.string().email().max(254).optional(),
  phone: z.string().max(32).optional(),
  name: z.string().max(200).optional(),
  contactConsent: z.boolean().nullable().optional(),
}).strict();

const merchantEventSchema = z.object({
  merchantId: z.string().min(1).optional(),
  externalEventId: safeString,
  eventType: z.enum([
    NormalizedEventType.CHECKOUT_STARTED,
    NormalizedEventType.CHECKOUT_COMPLETED,
    NormalizedEventType.INVOICE_CREATED,
    NormalizedEventType.INVOICE_PAID,
    NormalizedEventType.PAYMENT_FAILED,
    NormalizedEventType.PAYMENT_SUCCEEDED,
    NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED,
  ]),
  occurredAt: z.string().datetime({ offset: true }),
  amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/).optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  customer: customerSchema.optional(),
  payment: z.object({ paymentId: safeString.optional(), orderId: safeString.optional(), subscriptionId: safeString.optional(), verifiedFailureCode: safeString.optional() }).strict().optional(),
  invoice: z.object({ invoiceId: safeString, invoiceNumber: safeString.optional(), dueDate: z.string().datetime({ offset: true }).optional(), paid: z.boolean().optional() }).strict().optional(),
  checkout: z.object({ checkoutSessionId: safeString, cartItemsSummary: z.string().max(500).optional() }).strict().optional(),
  metadata: safeMetadata.optional(),
}).strict().superRefine((body, ctx) => {
  if (!body.amount || !body.currency || Number(body.amount) <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A positive exact amount and ISO currency are required' });
  if ((body.eventType === NormalizedEventType.CHECKOUT_STARTED || body.eventType === NormalizedEventType.CHECKOUT_COMPLETED) && !body.checkout) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'checkout is required for checkout events' });
  if ((body.eventType === NormalizedEventType.INVOICE_CREATED || body.eventType === NormalizedEventType.INVOICE_PAID) && !body.invoice) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invoice is required for invoice events' });
  if (body.eventType === NormalizedEventType.PAYMENT_FAILED && !body.payment?.paymentId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'payment.paymentId is required for payment failures' });
  if (body.eventType === NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED && !body.payment?.subscriptionId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'payment.subscriptionId is required for subscription failures' });
  if (body.customer?.contactConsent !== undefined && !body.customer.externalCustomerId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Consent requires externalCustomerId' });
});

export interface MerchantEventRoutesOptions { ingestionService: EventIngestionService; outcomeObserver?: OutcomeObserver; }

export const merchantEventRoutes: FastifyPluginAsync<MerchantEventRoutesOptions> = async (app, options) => {
  app.post('/', async (req, reply) => {
    try {
      const principal = requirePrincipal(req);
      const body = merchantEventSchema.parse(req.body);
      if (body.merchantId && body.merchantId !== principal.merchantId) return reply.status(403).send({ error: 'Merchant scope does not match authenticated principal' });
      const event = MerchantEventNormalizer.normalize({
        merchantId: principal.merchantId, source: 'MERCHANT', externalEventId: body.externalEventId,
        eventType: body.eventType, occurredAt: body.occurredAt, dedupeKey: `merchant:${body.externalEventId}`,
        amount: body.amount, currency: body.currency, customer: body.customer || null, payment: body.payment || null,
        invoice: body.invoice || null, checkout: body.checkout || null, metadata: body.metadata || {},
      });
      const isMonetarySuccess = event.eventType === NormalizedEventType.PAYMENT_SUCCEEDED || event.eventType === NormalizedEventType.CHECKOUT_COMPLETED || event.eventType === NormalizedEventType.INVOICE_PAID;
      const ingested = await options.ingestionService.ingestEvent(event, { skipRiskDetection: isMonetarySuccess });
      if (isMonetarySuccess && ingested.created && options.outcomeObserver) await options.outcomeObserver.observeMerchantEvent(event, ingested.event.id);
      return reply.status(202).send({ eventId: ingested.event.id, deduplicated: ingested.deduplicated, eventType: event.eventType, acceptedAt: ingested.event.receivedAt });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation failed', details: error.errors });
      const message = error instanceof Error ? error.message : 'Merchant event ingestion failed';
      if (message.startsWith('UNAUTHORIZED')) return reply.status(401).send({ error: message });
      if (message === 'Merchant event identity was already accepted with different facts') return reply.status(409).send({ error: message });
      return reply.status(400).send({ error: message });
    }
  });
};
