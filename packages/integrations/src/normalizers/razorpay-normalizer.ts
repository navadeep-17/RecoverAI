import {
  MerchantEventSource,
  NormalizedEventType,
  NormalizedMerchantEvent,
  NormalizedMerchantEventSchema,
  UnsupportedProviderEventError,
  InvalidProviderAmountError,
  MissingEventIdentityError,
} from '@recoverai/shared';

export interface RazorpayRawPayload {
  entity?: string;
  account_id?: string;
  event?: string;
  contains?: string[];
  id?: string;
  event_id?: string;
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
        payment_link_id?: string;
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
    payment_link?: {
      entity?: {
        id?: string;
        amount?: number | string;
        currency?: string;
        status?: string;
        reference_id?: string;
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

export function formatPaiseToDecimalString(amountInPaise: unknown): string {
  if (amountInPaise === null || amountInPaise === undefined) {
    throw new InvalidProviderAmountError('Amount in paise is null or undefined', amountInPaise);
  }

  let str: string;
  if (typeof amountInPaise === 'number') {
    if (!Number.isSafeInteger(amountInPaise) || amountInPaise < 0) {
      throw new InvalidProviderAmountError('Amount in paise must be a non-negative safe integer', amountInPaise);
    }
    str = amountInPaise.toString();
  } else if (typeof amountInPaise === 'string') {
    const trimmed = amountInPaise.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new InvalidProviderAmountError('Amount in paise must be an exact numeric string without decimals or special characters', amountInPaise);
    }
    str = trimmed;
  } else {
    throw new InvalidProviderAmountError('Amount in paise must be a number or string', amountInPaise);
  }

  const paiseBigInt = BigInt(str);
  const rupees = paiseBigInt / 100n;
  const paise = paiseBigInt % 100n;
  return `${rupees.toString()}.${paise.toString().padStart(2, '0')}`;
}

export class RazorpayEventNormalizer {
  static normalize(
    merchantId: string,
    raw: RazorpayRawPayload,
    explicitEventId?: string,
  ): NormalizedMerchantEvent {
    const eventName = (raw.event || '').trim();
    const paymentEntity = raw.payload?.payment?.entity;
    const subscriptionEntity = raw.payload?.subscription?.entity;
    const invoiceEntity = raw.payload?.invoice?.entity;
    const paymentLinkEntity = raw.payload?.payment_link?.entity;

    let eventType: NormalizedEventType;
    if (eventName === 'payment.failed') {
      eventType = NormalizedEventType.PAYMENT_FAILED;
    } else if (eventName === 'payment.captured' || eventName === 'payment_link.paid') {
      eventType = NormalizedEventType.PAYMENT_SUCCEEDED;
    } else if (eventName === 'subscription.charged' || eventName === 'subscription.activated') {
      eventType = NormalizedEventType.PAYMENT_SUCCEEDED;
    } else if (eventName === 'subscription.pending' || eventName === 'subscription.halted') {
      eventType = NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED;
    } else if (eventName === 'invoice.paid') {
      eventType = NormalizedEventType.INVOICE_PAID;
    } else {
      // Any unsupported or unknown Razorpay event must fail closed and NOT produce revenue-risk events
      throw new UnsupportedProviderEventError('Razorpay', eventName || 'UNKNOWN');
    }

    const occurredAt = raw.created_at
      ? new Date(raw.created_at * 1000)
      : paymentEntity?.created_at
      ? new Date(paymentEntity.created_at * 1000)
      : new Date();

    const externalEventId = explicitEventId || raw.id || raw.event_id || null;
    const paymentId = paymentEntity?.id || null;
    const paymentLinkId = paymentEntity?.payment_link_id || paymentLinkEntity?.id || null;
    const invoiceId = invoiceEntity?.id || paymentEntity?.invoice_id || null;

    // Authoritative subscription extraction: only from subscription entity or invoice subscription_id (NEVER invoice_id)
    const subscriptionId = subscriptionEntity?.id || invoiceEntity?.subscription_id || null;

    // Enforce required identities per event type
    if (eventType === NormalizedEventType.PAYMENT_FAILED && !paymentId && !externalEventId) {
      throw new MissingEventIdentityError('PAYMENT_FAILED', 'paymentId or externalEventId');
    }
    if (eventType === NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED && !subscriptionId) {
      throw new MissingEventIdentityError('SUBSCRIPTION_RENEWAL_FAILED', 'subscriptionId');
    }
    if (eventType === NormalizedEventType.INVOICE_PAID && !invoiceId) {
      throw new MissingEventIdentityError('INVOICE_PAID', 'invoiceId');
    }

    // Deterministic dedupe key generation (NO Date.now() or Math.random())
    let dedupeKey: string;
    if (externalEventId) {
      dedupeKey = `razorpay:${merchantId}:event:${externalEventId}`;
    } else if (paymentId) {
      dedupeKey = `razorpay:${merchantId}:payment:${paymentId}:${eventName}`;
    } else if (subscriptionId) {
      dedupeKey = `razorpay:${merchantId}:sub:${subscriptionId}:${eventName}`;
    } else if (invoiceId) {
      dedupeKey = `razorpay:${merchantId}:inv:${invoiceId}:${eventName}`;
    } else if (paymentLinkId) {
      dedupeKey = `razorpay:${merchantId}:link:${paymentLinkId}:${eventName}`;
    } else {
      throw new MissingEventIdentityError(eventName, 'externalEventId or entityId');
    }

    let formattedAmount: string | null = null;
    if (paymentEntity?.amount !== undefined) {
      formattedAmount = formatPaiseToDecimalString(paymentEntity.amount);
    } else if (invoiceEntity?.amount !== undefined) {
      formattedAmount = formatPaiseToDecimalString(invoiceEntity.amount);
    } else if (paymentLinkEntity?.amount !== undefined) {
      formattedAmount = formatPaiseToDecimalString(paymentLinkEntity.amount);
    }

    const rawCurrency = paymentEntity?.currency || invoiceEntity?.currency || paymentLinkEntity?.currency;
    const requiresMoney = eventType === NormalizedEventType.PAYMENT_FAILED ||
      eventType === NormalizedEventType.PAYMENT_SUCCEEDED ||
      eventType === NormalizedEventType.INVOICE_PAID;
    if (requiresMoney && (!formattedAmount || !rawCurrency || !/^[A-Za-z]{3}$/.test(rawCurrency))) {
      throw new InvalidProviderAmountError('Authoritative monetary Razorpay events require valid amount and ISO currency', {
        amount: paymentEntity?.amount ?? invoiceEntity?.amount,
        currency: rawCurrency,
      });
    }
    const currency = rawCurrency ? rawCurrency.toUpperCase() : null;

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
        contactConsent: null, // Explicitly unknown until verified
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
            paid: invoiceEntity?.status === 'paid' || eventType === NormalizedEventType.INVOICE_PAID,
          }
        : null,
      metadata: {
        rawEventName: eventName,
        errorSource: paymentEntity?.error_source,
        errorStep: paymentEntity?.error_step,
        // This is provider-supplied lookup evidence only. The worker resolves it
        // against a tenant-scoped persisted RecoveryAction before any recovery.
        razorpayPaymentLinkId: paymentLinkId,
      },
      rawPayload: raw as Record<string, unknown>,
    };

    return NormalizedMerchantEventSchema.parse(normalized);
  }
}
