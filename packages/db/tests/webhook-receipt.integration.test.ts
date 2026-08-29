import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventRepository, prisma } from '../src/index.js';

describe('Webhook receipt tenant-scoped deduplication', () => {
  let dbAvailable = false;
  const eventRepo = new EventRepository();

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect();
  });

  it('atomically converges concurrent duplicate deliveries per merchant while allowing another tenant', async () => {
    if (!dbAvailable) return;
    const dedupeKey = `event:rzp_concurrent_${Date.now()}`;
    const receipt = (merchantId: string) => eventRepo.recordWebhookEvent({
      merchantId, provider: 'RAZORPAY', externalEventId: dedupeKey,
      signature: 'verified-signature', verified: true, dedupeKey, rawPayload: '{"event":"payment.failed"}',
    });

    const sameMerchant = await Promise.all(Array.from({ length: 5 }, () => receipt('phase7-merchant-a')));
    expect(sameMerchant.filter((item) => item.created)).toHaveLength(1);
    expect(new Set(sameMerchant.map((item) => item.event.id)).size).toBe(1);

    const otherMerchant = await receipt('phase7-merchant-b');
    expect(otherMerchant.created).toBe(true);
    expect(otherMerchant.event.merchantId).toBe('phase7-merchant-b');

    await prisma.webhookEvent.deleteMany({ where: { dedupeKey } });
  });
});
