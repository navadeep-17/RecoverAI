import {
  MerchantEventSource,
  NormalizedEventType,
  NormalizedMerchantEvent,
  NormalizedMerchantEventSchema,
} from '@recoverai/shared';

export interface DirectMerchantEventInput {
  merchantId: string;
  source?: MerchantEventSource;
  externalEventId?: string | null;
  eventType: NormalizedEventType;
  occurredAt?: Date | string;
  dedupeKey?: string;
  amount?: string | null;
  currency?: string | null;
  customer?: {
    externalCustomerId?: string | null;
    email?: string | null;
    phone?: string | null;
    name?: string | null;
    contactConsent?: boolean | null;
  } | null;
  payment?: {
    paymentId?: string | null;
    orderId?: string | null;
    invoiceId?: string | null;
    subscriptionId?: string | null;
    checkoutSessionId?: string | null;
    paymentMethod?: string | null;
    cardNetwork?: string | null;
    cardLast4?: string | null;
    bankName?: string | null;
    verifiedFailureCode?: string | null;
    gatewayErrorMessage?: string | null;
    retryAttemptNumber?: number | null;
  } | null;
  invoice?: {
    invoiceId: string;
    invoiceNumber?: string | null;
    dueDate?: Date | string | null;
    paid?: boolean | null;
  } | null;
  checkout?: {
    checkoutSessionId: string;
    cartItemsSummary?: string | null;
    abandonedAt?: Date | string | null;
  } | null;
  metadata?: Record<string, unknown> | null;
  rawPayload?: Record<string, unknown> | null;
}

export class MerchantEventNormalizer {
  static normalize(input: DirectMerchantEventInput): NormalizedMerchantEvent {
    const occurredAt = input.occurredAt
      ? typeof input.occurredAt === 'string'
        ? new Date(input.occurredAt)
        : input.occurredAt
      : new Date();

    const dedupeKey =
      input.dedupeKey ||
      `mch:${input.merchantId}:${input.eventType}:${input.externalEventId || input.payment?.paymentId || input.checkout?.checkoutSessionId || input.invoice?.invoiceId || Date.now()}`;

    const normalized: NormalizedMerchantEvent = {
      merchantId: input.merchantId,
      source: input.source || MerchantEventSource.MERCHANT,
      externalEventId: input.externalEventId || null,
      eventType: input.eventType,
      occurredAt,
      dedupeKey,
      amount: input.amount || null,
      currency: (input.currency || 'INR').toUpperCase(),
      customer: input.customer || null,
      payment: input.payment || null,
      invoice: input.invoice
        ? {
            invoiceId: input.invoice.invoiceId,
            invoiceNumber: input.invoice.invoiceNumber || null,
            dueDate: input.invoice.dueDate
              ? typeof input.invoice.dueDate === 'string'
                ? new Date(input.invoice.dueDate)
                : input.invoice.dueDate
              : null,
            paid: input.invoice.paid ?? null,
          }
        : null,
      checkout: input.checkout
        ? {
            checkoutSessionId: input.checkout.checkoutSessionId,
            cartItemsSummary: input.checkout.cartItemsSummary || null,
            abandonedAt: input.checkout.abandonedAt
              ? typeof input.checkout.abandonedAt === 'string'
                ? new Date(input.checkout.abandonedAt)
                : input.checkout.abandonedAt
              : null,
          }
        : null,
      metadata: input.metadata || {},
      rawPayload: input.rawPayload || {},
    };

    return NormalizedMerchantEventSchema.parse(normalized);
  }
}
