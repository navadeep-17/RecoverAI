import {
  NormalizedMerchantEvent,
  NormalizedMerchantEventSchema,
  AuditActorType,
} from '@recoverai/shared';
import {
  EventRepository,
  AuditRepository,
  MerchantEvent,
} from '@recoverai/db';
import { RiskDetector, DetectionResult } from '../detection/risk-detector.js';

export interface IngestionResult {
  deduplicated: boolean;
  created: boolean;
  event: MerchantEvent;
  detectionResult: DetectionResult;
}

export class EventIngestionService {
  constructor(
    private eventRepo: EventRepository,
    private auditRepo: AuditRepository,
    private riskDetector: RiskDetector,
  ) {}

  async ingestEvent(eventInput: NormalizedMerchantEvent): Promise<IngestionResult> {
    // 1. Strict Schema & Domain Validation
    const validatedEvent = NormalizedMerchantEventSchema.parse(eventInput);
    const merchantId = validatedEvent.merchantId;

    // 2. Persist with tenant-scoped idempotency
    const { created, event } = await this.eventRepo.recordMerchantEvent(merchantId, {
      source: validatedEvent.source,
      externalEventId: validatedEvent.externalEventId || undefined,
      type: validatedEvent.eventType,
      occurredAt: validatedEvent.occurredAt,
      dedupeKey: validatedEvent.dedupeKey,
      payloadJson: validatedEvent as unknown as Record<string, unknown>,
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

    // 5. Deterministic Risk Detection
    const detectionResult = await this.riskDetector.handleNormalizedEvent(validatedEvent);

    return {
      deduplicated: false,
      created: true,
      event,
      detectionResult,
    };
  }
}
