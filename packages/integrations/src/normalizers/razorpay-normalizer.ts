import {
  MerchantEventSource,
  NormalizedEventType,
  NormalizedMerchantEvent,
  NormalizedMerchantEventSchema,
} from '@recoverai/shared';

export interface RazorpayRawPayload {
  entity?: string;
  account_id?: string;
  event?: string;
  contains?: string[];
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        amount?: number | string;
        currency?: string;
        status?: string;
        order_id?: string;
        invoice_id?: string;
        method?: string;
        email?: string;
        contact?: string;
        customer_id?: string;
        error_code?: string;
        error_description?: string;
        error_source?: string;
        error_step?: string;
        error_reason?: string;
        card?: {
          network?: string;
          last4?: string;
          name?: string;
        };
        bank?: string;
        wallet?: string;
        vpa?: string;
        created_at?: number;
      };
    };
    subscription?: {
      entity?: {
        id?: string;
        plan_id?: string;
        customer_id?: string;
        status?: string;
        current_start?: number;
        current_end?: number;
        charge_at?: number;
        created_at?: number;
      };
    };
    invoice?: {
      entity?: {
        id?: string;
        invoice_number?: string;
        customer_id?: string;
        order_id?: string;
        subscription_id?: string;
        amount?: number | string;
        currency?: string;
        status?: string;
        expire_by?: number;
        issued_at?: number;
        paid_at?: number;
        created_at?: number;
      };
    };
  };
  created_at?: number;
}

export function formatPaiseToDecimalString(amountInPaise: number | string): string {
  const num = typeof amountInPaise === 'string' ? parseInt(amountInPaise, 10) : amountInPaise;
  if (isNaN(num) || num < 0) {
    return '0.00';
  }
  const rupees = Math.floor(num / 100);
  const paise = num % 100;
  return `${rupees}.${paise.toString().padStart(2, '0')}`;
}

export class RazorpayEventNormalizer {
  static normalize(
    merchantId: string,
    raw: RazorpayRawPayload,
    externalEventId?: string,
  ): NormalizedMerchantEvent {
    const eventName = raw.event || '';
    const paymentEntity = raw.payload?.payment?.entity;
    const subscriptionEntity = raw.payload?.subscription?.entity;
    const invoiceEntity = raw.payload?.invoice?.entity;

    let eventType: NormalizedEventType;
    if (eventName === 'payment.failed') {
      eventType = NormalizedEventType.PAYMENT_FAILED;
    } else if (eventName === 'payment.captured' || eventName === 'payment.authorized') {
      eventType = NormalizedEventType.PAYMENT_SUCCEEDED;
    } else if (eventName === 'subscription.charged' || eventName === 'subscription.activated') {
      eventType = NormalizedEventType.PAYMENT_SUCCEEDED;
    } else if (eventName === 'subscription.pending' || eventName === 'subscription.halted') {
      eventType = NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED;
    } else if (eventName === 'invoice.paid') {
      eventType = NormalizedEventType.INVOICE_PAID;
    } else {
      eventType = NormalizedEventType.PAYMENT_FAILED;
    }

    const occurredAt = raw.created_at
      ? new Date(raw.created_at * 1000)
      : paymentEntity?.created_at
      ? new Date(paymentEntity.created_at * 1000)
      : new Date();

    const paymentId = paymentEntity?.id || null;
    const subscriptionId = subscriptionEntity?.id || paymentEntity?.invoice_id || null;
    const invoiceId = invoiceEntity?.id || paymentEntity?.invoice_id || null;
    const dedupeKey = externalEventId
      ? `razorpay:${merchantId}:${externalEventId}`
      : paymentId
      ? `razorpay:${merchantId}:${paymentId}:${eventName}`
      : `razorpay:${merchantId}:${Date.now()}:${Math.random().toString(36).substring(2, 9)}`;

    let formattedAmount: string | null = null;
    if (paymentEntity?.amount !== undefined) {
      formattedAmount = formatPaiseToDecimalString(paymentEntity.amount);
    } else if (invoiceEntity?.amount !== undefined) {
      formattedAmount = formatPaiseToDecimalString(invoiceEntity.amount);
    }

    const currency = (paymentEntity?.currency || invoiceEntity?.currency || 'INR').toUpperCase();

    const normalized: NormalizedMerchantEvent = {
      merchantId,
      source: MerchantEventSource.RAZORPAY,
      externalEventId: externalEventId || paymentId || null,
      eventType,
      occurredAt,
      dedupeKey,
      amount: formattedAmount,
      currency,
      customer: {
        externalCustomerId: paymentEntity?.customer_id || invoiceEntity?.customer_id || null,
        email: paymentEntity?.email || null,
        phone: paymentEntity?.contact || null,
        name: null,
        contactConsent: null, // Unknown until verified
      },
      payment: {
        paymentId,
        orderId: paymentEntity?.order_id || invoiceEntity?.order_id || null,
        invoiceId,
        subscriptionId,
        paymentMethod: paymentEntity?.method || null,
        cardNetwork: paymentEntity?.card?.network || null,
        cardLast4: paymentEntity?.card?.last4 || null,
        bankName: paymentEntity?.bank || null,
        verifiedFailureCode: paymentEntity?.error_code || paymentEntity?.error_reason || null,
        gatewayErrorMessage: paymentEntity?.error_description || null,
      },
      invoice: invoiceId
        ? {
            invoiceId,
            invoiceNumber: invoiceEntity?.invoice_number || null,
            dueDate: invoiceEntity?.expire_by ? new Date(invoiceEntity.expire_by * 1000) : null,
            paid: invoiceEntity?.status === 'paid',
          }
        : null,
      metadata: {
        rawEventName: eventName,
        errorSource: paymentEntity?.error_source,
        errorStep: paymentEntity?.error_step,
      },
      rawPayload: raw as Record<string, unknown>,
    };

    return NormalizedMerchantEventSchema.parse(normalized);
  }
}
