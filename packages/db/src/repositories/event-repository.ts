import { Prisma, MerchantEvent, WebhookEvent, EventSource } from '@prisma/client';
import { prisma } from '../client.js';

export class EventRepository {
  async recordMerchantEvent(
    merchantId: string,
    data: {
      source: EventSource;
      externalEventId?: string;
      type: string;
      occurredAt?: Date;
      dedupeKey: string;
      payloadJson: Record<string, unknown>;
    },
  ): Promise<{ created: boolean; event: MerchantEvent }> {
    try {
      const event = await prisma.merchantEvent.create({
        data: {
          merchantId,
          source: data.source,
          externalEventId: data.externalEventId,
          type: data.type,
          occurredAt: data.occurredAt || new Date(),
          dedupeKey: data.dedupeKey,
          payloadJson: data.payloadJson as Prisma.InputJsonValue,
        },
      });
      return { created: true, event };
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        // Enforce tenant-scoped duplicate recovery
        const existing = await prisma.merchantEvent.findUniqueOrThrow({
          where: {
            merchantId_dedupeKey: {
              merchantId,
              dedupeKey: data.dedupeKey,
            },
          },
        });
        return { created: false, event: existing };
      }
      throw err;
    }
  }

  async recordWebhookEvent(data: {
    provider: string;
    externalEventId?: string;
    signature?: string;
    verified: boolean;
    dedupeKey: string;
    rawPayload: string;
  }): Promise<{ created: boolean; event: WebhookEvent }> {
    try {
      const event = await prisma.webhookEvent.create({
        data: {
          provider: data.provider,
          externalEventId: data.externalEventId,
          signature: data.signature,
          verified: data.verified,
          dedupeKey: data.dedupeKey,
          rawPayload: data.rawPayload,
        },
      });
      return { created: true, event };
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        const existing = await prisma.webhookEvent.findUniqueOrThrow({
          where: { dedupeKey: data.dedupeKey },
        });
        return { created: false, event: existing };
      }
      throw err;
    }
  }

  async markWebhookProcessed(dedupeKey: string): Promise<WebhookEvent> {
    return prisma.webhookEvent.update({
      where: { dedupeKey },
      data: { processed: true },
    });
  }
}
