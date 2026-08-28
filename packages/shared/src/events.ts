import { z } from 'zod';
import { MerchantEventSource, NormalizedEventType } from './constants.js';
import { Money } from './money.js';

export const NormalizedCustomerReferenceSchema = z.object({
  externalCustomerId: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  contactConsent: z.boolean().nullable().optional(),
});

export type NormalizedCustomerReference = z.infer<typeof NormalizedCustomerReferenceSchema>;

export const NormalizedPaymentReferenceSchema = z.object({
  paymentId: z.string().nullable().optional(),
  orderId: z.string().nullable().optional(),
  invoiceId: z.string().nullable().optional(),
  subscriptionId: z.string().nullable().optional(),
  checkoutSessionId: z.string().nullable().optional(),
  paymentMethod: z.string().nullable().optional(),
  cardNetwork: z.string().nullable().optional(),
  cardLast4: z.string().nullable().optional(),
  bankName: z.string().nullable().optional(),
  verifiedFailureCode: z.string().nullable().optional(),
  gatewayErrorMessage: z.string().nullable().optional(),
  retryAttemptNumber: z.number().int().nonnegative().nullable().optional(),
});

export type NormalizedPaymentReference = z.infer<typeof NormalizedPaymentReferenceSchema>;

export const NormalizedInvoiceReferenceSchema = z.object({
  invoiceId: z.string().min(1),
  invoiceNumber: z.string().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  paid: z.boolean().nullable().optional(),
});

export type NormalizedInvoiceReference = z.infer<typeof NormalizedInvoiceReferenceSchema>;

export const NormalizedCheckoutReferenceSchema = z.object({
  checkoutSessionId: z.string().min(1),
  cartItemsSummary: z.string().nullable().optional(),
  abandonedAt: z.coerce.date().nullable().optional(),
});

export type NormalizedCheckoutReference = z.infer<typeof NormalizedCheckoutReferenceSchema>;

export const NormalizedMerchantEventSchema = z.object({
  merchantId: z.string().min(1),
  source: z.nativeEnum(MerchantEventSource),
  externalEventId: z.string().nullable().optional(),
  eventType: z.nativeEnum(NormalizedEventType),
  occurredAt: z.coerce.date(),
  dedupeKey: z.string().min(1),
  amount: z
    .string()
    .refine((val) => Money.isValidDecimalString(val), {
      message: 'Amount must be a valid non-negative exact decimal monetary string with at most 2 decimal places',
    })
    .nullable()
    .optional(),
  currency: z.string().min(3).max(3).toUpperCase().default('INR').nullable().optional(),
  customer: NormalizedCustomerReferenceSchema.nullable().optional(),
  payment: NormalizedPaymentReferenceSchema.nullable().optional(),
  invoice: NormalizedInvoiceReferenceSchema.nullable().optional(),
  checkout: NormalizedCheckoutReferenceSchema.nullable().optional(),
  metadata: z.record(z.unknown()).default({}).nullable().optional(),
  rawPayload: z.record(z.unknown()).default({}).nullable().optional(),
});

export type NormalizedMerchantEvent = z.infer<typeof NormalizedMerchantEventSchema>;
