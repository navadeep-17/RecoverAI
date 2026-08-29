import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RecoveryActionType } from '@recoverai/shared';
import { ProviderExecutionOutcome } from '@recoverai/core';
import { RazorpayPaymentLinkProvider } from '../src/providers/razorpay-payment-link-provider.js';
import { RazorpayWebhookService } from '../src/razorpay-webhook-service.js';

const merchantId = 'mch_rzp_test';
const secret = 'webhook-secret-for-tests';
const rawPaymentFailed = '{\n  "id":"evt_001", "event":"payment.failed", "payload":{"payment":{"entity":{"id":"pay_001","amount":12345,"currency":"INR","created_at":1720000000}}}\n}';

function signature(raw: string): string {
  return createHmac('sha256', secret).update(Buffer.from(raw)).digest('hex');
}

function webhookService(overrides: Record<string, unknown> = {}) {
  const eventRepo = {
    recordWebhookEvent: vi.fn().mockResolvedValue({ created: true, event: { id: 'wh_001' } }),
    markWebhookProcessed: vi.fn().mockResolvedValue({}),
  };
  const auditRepo = { record: vi.fn().mockResolvedValue({}) };
  const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
  return {
    eventRepo,
    auditRepo,
    queue,
    service: new RazorpayWebhookService({ merchantId, webhookSecret: secret, eventRepo: eventRepo as any, auditRepo: auditRepo as any, queue, ...overrides }),
  };
}

describe('Phase 7 Razorpay boundaries', () => {
  it('accepts a valid signature over the exact raw bytes and durably enqueues once', async () => {
    const { service, eventRepo, queue } = webhookService();
    const result = await service.accept(Buffer.from(rawPaymentFailed), signature(rawPaymentFailed));
    expect(result).toMatchObject({ accepted: true, duplicate: false, unsupported: false });
    expect(eventRepo.recordWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ merchantId, provider: 'RAZORPAY', verified: true }));
    expect(queue.enqueue).toHaveBeenCalledWith({ merchantId, webhookEventId: 'wh_001' });
  });

  it('rejects an HMAC made over reconstructed JSON and persists no trusted event', async () => {
    const { service, eventRepo, queue } = webhookService();
    const reconstructed = JSON.stringify(JSON.parse(rawPaymentFailed));
    const result = await service.accept(Buffer.from(rawPaymentFailed), signature(reconstructed));
    expect(result).toMatchObject({ accepted: false, statusCode: 401 });
    expect(eventRepo.recordWebhookEvent).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('rejects missing signatures without trusted persistence', async () => {
    const { service, eventRepo } = webhookService();
    expect(await service.accept(Buffer.from(rawPaymentFailed), undefined)).toMatchObject({ accepted: false, statusCode: 401 });
    expect(eventRepo.recordWebhookEvent).not.toHaveBeenCalled();
  });

  it('converges duplicate verified deliveries without a second enqueue', async () => {
    const { eventRepo, queue } = webhookService();
    eventRepo.recordWebhookEvent.mockResolvedValue({ created: false, event: { id: 'wh_001', processed: true } });
    const service = new RazorpayWebhookService({ merchantId, webhookSecret: secret, eventRepo: eventRepo as any, auditRepo: { record: vi.fn() } as any, queue });
    expect(await service.accept(Buffer.from(rawPaymentFailed), signature(rawPaymentFailed))).toMatchObject({ accepted: true, duplicate: true });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('re-enqueues an unfinished verified receipt when Razorpay retries after a handoff failure', async () => {
    const { eventRepo, queue } = webhookService();
    eventRepo.recordWebhookEvent.mockResolvedValue({ created: false, event: { id: 'wh_001', processed: false } });
    const service = new RazorpayWebhookService({ merchantId, webhookSecret: secret, eventRepo: eventRepo as any, auditRepo: { record: vi.fn() } as any, queue });
    expect(await service.accept(Buffer.from(rawPaymentFailed), signature(rawPaymentFailed))).toMatchObject({ accepted: true, duplicate: true });
    expect(queue.enqueue).toHaveBeenCalledWith({ merchantId, webhookEventId: 'wh_001' });
  });

  it('does not normalize unsupported authenticated events into payment failures', async () => {
    const raw = '{"id":"evt_unknown","event":"refund.created","payload":{}}';
    const { service, queue, eventRepo } = webhookService();
    expect(await service.accept(Buffer.from(raw), signature(raw))).toMatchObject({ accepted: true, unsupported: true });
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(eventRepo.markWebhookProcessed).toHaveBeenCalled();
  });

  it('creates a real payment-link contract with exact paise and no recovery claim', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'plink_001', short_url: 'https://rzp.io/i/test', status: 'created' }), { status: 200 }));
    const provider = new RazorpayPaymentLinkProvider({ keyId: 'rzp_test_key', keySecret: 'test_secret', fetchImpl });
    const result = await provider.execute({ merchantId, caseId: 'case_001', actionId: 'act_001', actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, idempotencyKey: 'idem_001', actionParams: {}, caseSummary: { riskType: 'PAYMENT_FAILURE', amountAtRisk: '123.45', currency: 'INR' } });
    expect(result.outcome).toBe(ProviderExecutionOutcome.SUCCESS);
    expect(result.metadata).toMatchObject({ amountPaise: 12345, currency: 'INR', recoveryConfirmed: false });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ amount: 12345, currency: 'INR', notes: { recoverai_case_id: 'case_001', recoverai_action_id: 'act_001' } });
  });

  it('fails closed when credentials are missing or the provider rejects the request', async () => {
    const missing = new RazorpayPaymentLinkProvider();
    const input = { merchantId, caseId: 'case_001', actionId: 'act_001', actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, idempotencyKey: 'idem_001', actionParams: {}, caseSummary: { riskType: 'PAYMENT_FAILURE', amountAtRisk: '1.00', currency: 'INR' } };
    expect((await missing.execute(input)).outcome).toBe(ProviderExecutionOutcome.PERMANENT_FAILURE);
    const rejected = new RazorpayPaymentLinkProvider({ keyId: 'id', keySecret: 'secret', fetchImpl: vi.fn().mockResolvedValue(new Response('{}', { status: 500 })) });
    expect((await rejected.execute(input)).outcome).toBe(ProviderExecutionOutcome.RETRYABLE_FAILURE);
  });
});
