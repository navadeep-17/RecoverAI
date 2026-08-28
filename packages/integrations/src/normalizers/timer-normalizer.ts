import {
  MerchantEventSource,
  NormalizedEventType,
  NormalizedMerchantEvent,
  NormalizedMerchantEventSchema,
} from '@recoverai/shared';

export interface TimerEventInput {
  merchantId: string;
  timerType: 'CHECKOUT_ABANDONMENT_TIMER' | 'INVOICE_OVERDUE_TIMER' | 'RECOVERY_TIMER_FIRED' | 'RECOVERY_TIMEOUT';
  timerId: string;
  firedAt: Date;
  referenceId: string;
  metadata?: Record<string, unknown>;
}

export class TimerEventNormalizer {
  static normalize(input: TimerEventInput): NormalizedMerchantEvent {
    let eventType: NormalizedEventType;
    if (input.timerType === 'RECOVERY_TIMEOUT') {
      eventType = NormalizedEventType.RECOVERY_TIMEOUT;
    } else {
      eventType = NormalizedEventType.RECOVERY_TIMER_FIRED;
    }

    const dedupeKey = `timer:${input.merchantId}:${input.timerType}:${input.timerId}`;

    const normalized: NormalizedMerchantEvent = {
      merchantId: input.merchantId,
      source: MerchantEventSource.TIMER,
      externalEventId: input.timerId,
      eventType,
      occurredAt: input.firedAt,
      dedupeKey,
      metadata: {
        timerType: input.timerType,
        referenceId: input.referenceId,
        ...(input.metadata || {}),
      },
    };

    return NormalizedMerchantEventSchema.parse(normalized);
  }
}
