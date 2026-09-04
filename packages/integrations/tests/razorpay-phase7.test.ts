import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RecoveryActionType } from '@recoverai/shared';
import { ProviderExecutionOutcome } from '@recoverai/core';
import { RazorpayPaymentLinkProvider } from '../src/providers/razorpay-payment-link-provider.js';
import { RazorpayWebhookService } from '../src/razorpay-webhook-service.js';
import { ProviderRegistry } from '../src/providers/provider-registry.js';
import { RazorpayEventNormalizer } from '../src/normalizers/razorpay-normalizer.js';

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
    service: new RazorpayWebhookService({
      merchantId,
      webhookSecret: secret,
      eventRepo: eventRepo as any,
      auditRepo: auditRepo as any,
      queue,
      ...overrides,
    }),
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
    expect(await service.accept(Buffer.from(rawPaymentFailed), undefined)).toMatchObject({
      accepted: false,
      statusCode: 401,
    });
    expect(eventRepo.recordWebhookEvent).not.toHaveBeenCalled();
  });

  it('converges duplicate verified deliveries without a second enqueue', async () => {
    const { eventRepo, queue } = webhookService();
    eventRepo.recordWebhookEvent.mockResolvedValue({
      created: false,
      event: { id: 'wh_001', processed: true },
    });
    const service = new RazorpayWebhookService({
      merchantId,
      webhookSecret: secret,
      eventRepo: eventRepo as any,
      auditRepo: { record: vi.fn() } as any,
      queue,
    });
    expect(await service.accept(Buffer.from(rawPaymentFailed), signature(rawPaymentFailed))).toMatchObject({ accepted: true, duplicate: true });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('re-enqueues an unfinished verified receipt when Razorpay retries after a handoff failure', async () => {
    const { eventRepo, queue } = webhookService();
    eventRepo.recordWebhookEvent.mockResolvedValue({
      created: false,
      event: { id: 'wh_001', processed: false },
    });
    const service = new RazorpayWebhookService({
      merchantId,
      webhookSecret: secret,
      eventRepo: eventRepo as any,
      auditRepo: { record: vi.fn() } as any,
      queue,
    });
    expect(await service.accept(Buffer.from(rawPaymentFailed), signature(rawPaymentFailed))).toMatchObject({ accepted: true, duplicate: true });
    expect(queue.enqueue).toHaveBeenCalledWith({ merchantId, webhookEventId: 'wh_001' });
  });

  it('does not normalize unsupported authenticated events into payment failures', async () => {
    const raw = '{"id":"evt_unknown","event":"refund.created","payload":{}}';
    const { service, queue, eventRepo } = webhookService();
    expect(await service.accept(Buffer.from(raw), signature(raw))).toMatchObject({
      accepted: true,
      unsupported: true,
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(eventRepo.markWebhookProcessed).toHaveBeenCalled();
  });

  it('creates a real payment-link contract with exact paise and no recovery claim', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'plink_001',
          short_url: 'https://rzp.io/i/test',
          status: 'created',
        }),
        { status: 200 },
      ),
    );
    const provider = new RazorpayPaymentLinkProvider({
      keyId: 'rzp_test_key',
      keySecret: 'test_secret',
      boundMerchantId: merchantId,
      fetchImpl,
    });
    const result = await provider.execute({
      merchantId,
      caseId: 'case_001',
      actionId: 'act_001',
      actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      idempotencyKey: 'idem_001',
      actionParams: {},
      caseSummary: { riskType: 'PAYMENT_FAILURE', amountAtRisk: '123.45', currency: 'INR' },
    });
    expect(result.outcome).toBe(ProviderExecutionOutcome.SUCCESS);
    expect(result.metadata).toMatchObject({
      amountPaise: 12345,
      currency: 'INR',
      recoveryConfirmed: false,
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      amount: 12345,
      currency: 'INR',
      notes: { recoverai_case_id: 'case_001', recoverai_action_id: 'act_001' },
    });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a hung request once and reports ambiguous retryable failure without recovered money', async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
    );
    const provider = new RazorpayPaymentLinkProvider({
      keyId: 'rzp_test_key',
      keySecret: 'test_secret',
      boundMerchantId: merchantId,
      fetchImpl: fetchImpl as typeof fetch,
      timeoutMs: 10,
    });
    const result = await provider.execute({
      merchantId,
      caseId: 'case_timeout',
      actionId: 'act_timeout',
      actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      idempotencyKey: 'idem_timeout',
      actionParams: {},
      caseSummary: { riskType: 'PAYMENT_FAILURE', amountAtRisk: '123.45', currency: 'INR' },
    });
    expect(result).toMatchObject({
      outcome: ProviderExecutionOutcome.RETRYABLE_FAILURE,
      errorClassification: 'NETWORK_TIMEOUT',
      idempotencyKey: 'idem_timeout',
    });
    expect(result.errorMessage).toContain('ambiguous provider state');
    expect(result.metadata).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed for an unbound or foreign merchant before any network request', async () => {
    const fetchImpl = vi.fn();
    const input = {
      merchantId,
      caseId: 'case_merchant',
      actionId: 'act_merchant',
      actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      idempotencyKey: 'idem_merchant',
      actionParams: {},
      caseSummary: { riskType: 'PAYMENT_FAILURE', amountAtRisk: '123.45', currency: 'INR' },
    };
    const foreign = new RazorpayPaymentLinkProvider({
      keyId: 'rzp_test_key',
      keySecret: 'test_secret',
      boundMerchantId: 'merchant-other',
      fetchImpl,
    });
    const unbound = new RazorpayPaymentLinkProvider({
      keyId: 'rzp_test_key',
      keySecret: 'test_secret',
      fetchImpl,
    });

    await expect(foreign.execute(input)).resolves.toMatchObject({
      outcome: ProviderExecutionOutcome.PERMANENT_FAILURE,
      errorMessage: expect.stringContaining('not authorized'),
    });
    await expect(unbound.execute(input)).resolves.toMatchObject({
      outcome: ProviderExecutionOutcome.PERMANENT_FAILURE,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when credentials are missing or the provider rejects the request', async () => {
    const missing = new RazorpayPaymentLinkProvider();
    const input = {
      merchantId,
      caseId: 'case_001',
      actionId: 'act_001',
      actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      idempotencyKey: 'idem_001',
      actionParams: {},
      caseSummary: { riskType: 'PAYMENT_FAILURE', amountAtRisk: '1.00', currency: 'INR' },
    };
    expect((await missing.execute(input)).outcome).toBe(ProviderExecutionOutcome.PERMANENT_FAILURE);
    const rejected = new RazorpayPaymentLinkProvider({
      keyId: 'id',
      keySecret: 'secret',
      boundMerchantId: merchantId,
      fetchImpl: vi.fn().mockResolvedValue(new Response('{}', { status: 500 })),
    });
    expect((await rejected.execute(input)).outcome).toBe(ProviderExecutionOutcome.RETRYABLE_FAILURE);
  });

  it('does not normalize payment.authorized as a payment-success recovery event', () => {
    const raw = {
      id: 'evt_authorized',
      event: 'payment.authorized',
      payload: { payment: { entity: { id: 'pay_authorized', amount: 100, currency: 'INR' } } },
    };
    expect(() => RazorpayEventNormalizer.normalize(merchantId, raw)).toThrow(/Unsupported Razorpay event/);
  });

  it('normalizes subscription.charged only with authoritative money evidence', () => {
    const normalized = RazorpayEventNormalizer.normalize(merchantId, {
      id: 'evt_sub_charge',
      event: 'subscription.charged',
      created_at: 1720000000,
      payload: {
        payment: {
          entity: {
            id: 'pay_sub_charge',
            subscription_id: 'sub_1',
            amount: 1499900,
            currency: 'INR',
          },
        },
      },
    } as any);
    expect(normalized.eventType).toBe('PAYMENT_SUCCEEDED');
    expect(normalized.amount).toBe('14999.00');
    expect(normalized.currency).toBe('INR');
    expect(() =>
      RazorpayEventNormalizer.normalize(merchantId, {
        id: 'evt_sub_missing_money',
        event: 'subscription.charged',
        payload: { subscription: { entity: { id: 'sub_1' } } },
      } as any),
    ).toThrow();
  });

  it('rejects subscription.activated as non-monetary lifecycle evidence', () => {
    expect(() =>
      RazorpayEventNormalizer.normalize(merchantId, {
        id: 'evt_sub_activated',
        event: 'subscription.activated',
        payload: { subscription: { entity: { id: 'sub_1' } } },
      } as any),
    ).toThrow(/Unsupported Razorpay event/);
  });

  it.each([
    ['payment.failed', { payment: { entity: { id: 'pay_failed', amount: 100, currency: 'INR' } } }, 'PAYMENT_FAILED'],
    ['payment.captured', { payment: { entity: { id: 'pay_captured', amount: 200, currency: 'INR' } } }, 'PAYMENT_SUCCEEDED'],
    [
      'payment_link.paid',
      {
        payment: {
          entity: {
            id: 'pay_link',
            payment_link_id: 'plink_accepted',
            amount: 300,
            currency: 'INR',
          },
        },
        payment_link: { entity: { id: 'plink_accepted', reference_id: 'rcv_action' } },
      },
      'PAYMENT_SUCCEEDED',
    ],
    [
      'subscription.charged',
      {
        payment: { entity: { id: 'pay_subscription', amount: 400, currency: 'INR' } },
        subscription: { entity: { id: 'sub_charged' } },
      },
      'PAYMENT_SUCCEEDED',
    ],
    ['subscription.pending', { subscription: { entity: { id: 'sub_pending' } } }, 'SUBSCRIPTION_RENEWAL_FAILED'],
    ['subscription.halted', { subscription: { entity: { id: 'sub_halted' } } }, 'SUBSCRIPTION_RENEWAL_FAILED'],
    ['invoice.paid', { invoice: { entity: { id: 'inv_paid', amount: 500, currency: 'INR', status: 'paid' } } }, 'INVOICE_PAID'],
  ])('accepts the repository payload contract for %s', (event, payload, expectedType) => {
    const normalized = RazorpayEventNormalizer.normalize(merchantId, {
      id: `evt_${event.replace('.', '_')}`,
      event,
      payload,
    });
    expect(normalized.eventType).toBe(expectedType);
  });

  it('uses the real payment-link adapter only through explicit Test Mode runtime configuration', () => {
    const configured = ProviderRegistry.forRuntime({
      enabled: true,
      keyId: 'rzp_test_key',
      keySecret: 'secret',
      boundMerchantId: merchantId,
    });
    const safeDefault = ProviderRegistry.forRuntime({ enabled: false });
    expect(configured.getProviderForAction(RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK)?.providerName).toBe('RAZORPAY_TEST_MODE_PAYMENT_LINKS');
    expect(safeDefault.getProviderForAction(RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK)?.isSimulated).toBe(true);
    expect(configured.getProviderForAction(RecoveryActionType.SEND_RECEIVABLE_REMINDER)?.providerName).toBe('SIMULATED_RECOVERY_PROVIDER');
    expect(configured.getProviderForAction(RecoveryActionType.STOP_RECOVERY)).toBeNull();
  });
});
