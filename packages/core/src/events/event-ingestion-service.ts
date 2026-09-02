import {
  NormalizedMerchantEvent,
  NormalizedMerchantEventSchema,
  AuditActorType,
} from '@recoverai/shared';
import {
  EventRepository,
  AuditRepository,
  CustomerRepository,
  MerchantEvent,
} from '@recoverai/db';
import { RiskDetector, DetectionResult } from '../detection/risk-detector.js';

export interface IngestionResult {
  deduplicated: boolean;
  created: boolean;
  event: MerchantEvent;
  detectionResult: DetectionResult;
}

export interface EventIngestionOptions {
  /** A separately authorized observer owns this event's state transition. */
  skipRiskDetection?: boolean;
}

export class EventIngestionService {
  constructor(
    private eventRepo: EventRepository,
    private auditRepo: AuditRepository,
    private riskDetector: RiskDetector,
    private customerRepo?: CustomerRepository,
  ) {}

  async ingestEvent(eventInput: NormalizedMerchantEvent, options: EventIngestionOptions = {}): Promise<IngestionResult> {
    // 1. Strict Schema & Domain Validation
    const validatedEvent = NormalizedMerchantEventSchema.parse(eventInput);
    const merchantId = validatedEvent.merchantId;
    const canonicalPayload = JSON.parse(JSON.stringify(validatedEvent)) as Record<string, unknown>;

    // 2. Persist with tenant-scoped idempotency
    const { created, event } = await this.eventRepo.recordMerchantEvent(merchantId, {
      source: validatedEvent.source,
      externalEventId: validatedEvent.externalEventId || undefined,
      type: validatedEvent.eventType,
      occurredAt: validatedEvent.occurredAt,
      dedupeKey: validatedEvent.dedupeKey,
      payloadJson: canonicalPayload,
    });

    // 3. If duplicate event for this merchant, skip risk detection
    if (!created) {
      await this.auditRepo.record(merchantId, {
        eventType: 'DETECTION_SKIPPED_DUPLICATE',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: {
          dedupeKey: validatedEvent.dedupeKey,
          eventType: validatedEvent.eventType,
        },
        reasonCode: 'DUPLICATE_EVENT_INGESTION_SKIPPED',
      });

      return {
        deduplicated: true,
        created: false,
        event,
        detectionResult: {
          riskDetected: false,
          caseCreated: false,
          deduplicated: true,
          reason: 'Duplicate merchant event received; detection skipped',
        },
      };
    }

    // Consent is authoritative only when the merchant explicitly supplies it.
    // No absent value is inferred or promoted to true.
    if (this.customerRepo && validatedEvent.customer?.externalCustomerId) {
      await this.customerRepo.upsertAuthoritativeCustomerFacts(merchantId, {
        externalCustomerId: validatedEvent.customer.externalCustomerId,
        email: validatedEvent.customer.email || undefined,
        phone: validatedEvent.customer.phone || undefined,
        name: validatedEvent.customer.name || undefined,
        // Unknown provider consent is not an authoritative instruction to
        // erase an existing merchant-provided consent fact.
        ...(typeof validatedEvent.customer.contactConsent === 'boolean'
          ? { contactConsent: validatedEvent.customer.contactConsent }
          : {}),
      });
    }

    // 4. Record successful ingestion audit
    await this.auditRepo.record(merchantId, {
      eventType: 'EVENT_INGESTED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: {
        eventId: event.id,
        eventType: validatedEvent.eventType,
        source: validatedEvent.source,
        dedupeKey: validatedEvent.dedupeKey,
      },
      reasonCode: 'EVENT_INGESTION_SUCCESS',
    });

    // 5. Deterministic Risk Detection. Payment-link success is intentionally
    // withheld until the worker has resolved its link ID to a persisted action.
    if (options.skipRiskDetection) {
      return {
        deduplicated: false,
        created: true,
        event,
        detectionResult: { riskDetected: false, caseCreated: false, reason: 'Risk detection deferred to authoritative outcome correlation' },
      };
    }

    const detectionResult = await this.riskDetector.handleNormalizedEvent(validatedEvent);

    return {
      deduplicated: false,
      created: true,
      event,
      detectionResult,
    };
  }
}
