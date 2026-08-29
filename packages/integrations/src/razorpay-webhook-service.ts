import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AuditActorType, EventRepository, AuditRepository } from '@recoverai/db';
import { EventIngestionService } from '@recoverai/core';
import { RazorpayEventNormalizer, RazorpayRawPayload } from './normalizers/razorpay-normalizer.js';

export interface RazorpayWebhookQueue {
  enqueue(payload: { merchantId: string; webhookEventId: string }): Promise<void>;
}

export interface RazorpayWebhookServiceOptions {
  merchantId?: string;
  webhookSecret?: string;
  eventRepo: EventRepository;
  auditRepo: AuditRepository;
  ingestionService?: EventIngestionService;
  queue?: RazorpayWebhookQueue;
}

export type RazorpayWebhookAcceptance =
  | { accepted: true; duplicate: boolean; unsupported: boolean; webhookEventId: string }
  | { accepted: false; statusCode: 400 | 401 | 503; reason: string };

/** Verifies raw Razorpay deliveries before any trusted event or recovery processing exists. */
export class RazorpayWebhookService {
  constructor(private readonly options: RazorpayWebhookServiceOptions) {}

  async accept(rawBody: Buffer, signature: string | undefined): Promise<RazorpayWebhookAcceptance> {
    if (!this.options.merchantId || !this.options.webhookSecret) {
      return { accepted: false, statusCode: 503, reason: 'Razorpay webhook configuration unavailable' };
    }
    if (!this.options.queue && !this.options.ingestionService) {
      return { accepted: false, statusCode: 503, reason: 'Webhook processing queue unavailable' };
    }
    if (!signature || !this.validSignature(rawBody, signature)) {
      return { accepted: false, statusCode: 401, reason: 'Invalid webhook signature' };
    }

    let payload: RazorpayRawPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as RazorpayRawPayload;
    } catch {
      return { accepted: false, statusCode: 400, reason: 'Malformed webhook payload' };
    }

    const externalEventId = this.eventId(payload);
    const dedupeKey = externalEventId
      ? `event:${externalEventId}`
      : `raw:${createHash('sha256').update(rawBody).digest('hex')}`;
    const receipt = await this.options.eventRepo.recordWebhookEvent({
      merchantId: this.options.merchantId,
      provider: 'RAZORPAY',
      externalEventId: externalEventId || undefined,
      signature,
      verified: true,
      dedupeKey,
      rawPayload: rawBody.toString('utf8'),
    });
    if (!receipt.created) {
      await this.options.auditRepo.record(this.options.merchantId, {
        eventType: 'WEBHOOK_DUPLICATE', actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { provider: 'RAZORPAY', webhookEventId: receipt.event.id }, reasonCode: 'DUPLICATE_VERIFIED_WEBHOOK',
      });
      // A prior delivery can have committed the receipt before its queue handoff
      // failed. Re-enqueue only unfinished receipts so provider retries repair that
      // narrow gap without duplicating completed work.
      if (!receipt.event.processed && this.options.queue) {
        await this.options.queue.enqueue({ merchantId: this.options.merchantId, webhookEventId: receipt.event.id });
      }
      return { accepted: true, duplicate: true, unsupported: false, webhookEventId: receipt.event.id };
    }

    await this.options.auditRepo.record(this.options.merchantId, {
      eventType: 'WEBHOOK_VERIFIED', actorType: AuditActorType.SYSTEM,
      inputSummaryJson: { provider: 'RAZORPAY', webhookEventId: receipt.event.id, externalEventId }, reasonCode: 'RAZORPAY_SIGNATURE_VERIFIED',
    });

    try {
      RazorpayEventNormalizer.normalize(this.options.merchantId, payload, externalEventId || undefined);
    } catch (err) {
      // An authenticated unsupported/malformed provider event is retained as receipt evidence but never ingested.
      await this.options.eventRepo.markWebhookProcessed(this.options.merchantId, 'RAZORPAY', dedupeKey);
      await this.options.auditRepo.record(this.options.merchantId, {
        eventType: 'WEBHOOK_UNSUPPORTED', actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { provider: 'RAZORPAY', webhookEventId: receipt.event.id, event: payload.event || null }, reasonCode: 'UNSUPPORTED_OR_INVALID_RAZORPAY_EVENT',
      });
      return { accepted: true, duplicate: false, unsupported: true, webhookEventId: receipt.event.id };
    }

    if (this.options.queue) {
      await this.options.queue.enqueue({ merchantId: this.options.merchantId, webhookEventId: receipt.event.id });
    } else if (this.options.ingestionService) {
      // Test-only synchronous adapter. Production must provide the durable queue.
      await this.options.ingestionService.ingestEvent(
        RazorpayEventNormalizer.normalize(this.options.merchantId, payload, externalEventId || undefined),
      );
      await this.options.eventRepo.markWebhookProcessed(this.options.merchantId, 'RAZORPAY', dedupeKey);
    }
    return { accepted: true, duplicate: false, unsupported: false, webhookEventId: receipt.event.id };
  }

  private validSignature(rawBody: Buffer, received: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(received)) return false;
    const expected = createHmac('sha256', this.options.webhookSecret!).update(rawBody).digest();
    const actual = Buffer.from(received, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private eventId(payload: RazorpayRawPayload): string | null {
    return payload.id || payload.event_id || null;
  }
}
