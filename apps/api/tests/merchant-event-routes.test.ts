import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

const headers = (merchantId = 'merchant-a') => ({ 'x-merchant-id': merchantId, 'x-user-id': 'user-a' });
const valid = { externalEventId: 'evt-1', eventType: 'CHECKOUT_STARTED', occurredAt: '2026-08-30T10:00:00.000Z', amount: '8499.00', currency: 'INR', checkout: { checkoutSessionId: 'checkout-1' }, customer: { externalCustomerId: 'cust-1', contactConsent: true } };

describe('merchant event ingress route', () => {
  const apps: ReturnType<typeof buildServer>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
  const appWith = (ingest = vi.fn(async () => ({ created: true, deduplicated: false, event: { id: 'event-1', receivedAt: new Date('2026-08-30T10:00:01Z') } })) ) => {
    const app = buildServer({ checkDbConnection: async () => true, merchantEventIngestionService: { ingestEvent: ingest } as any }); apps.push(app); return { app, ingest };
  };

  it('binds merchant identity, normalizes merchant source, and returns a minimal receipt', async () => {
    const { app, ingest } = appWith();
    const result = await app.inject({ method: 'POST', url: '/merchant-events', headers: headers(), payload: valid });
    expect(result.statusCode).toBe(202);
    expect(result.json()).toMatchObject({ eventId: 'event-1', deduplicated: false, eventType: 'CHECKOUT_STARTED' });
    expect(ingest.mock.calls[0][0]).toMatchObject({ merchantId: 'merchant-a', source: 'MERCHANT', amount: '8499.00', currency: 'INR' });
  });

  it('rejects merchant spoofing, invalid money, unknown event type, and implicit consent', async () => {
    const { app, ingest } = appWith();
    expect((await app.inject({ method: 'POST', url: '/merchant-events', headers: headers(), payload: { ...valid, merchantId: 'merchant-b' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/merchant-events', headers: headers(), payload: { ...valid, amount: '0' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/merchant-events', headers: headers(), payload: { ...valid, eventType: 'UNKNOWN' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/merchant-events', headers: headers(), payload: { ...valid, customer: { externalCustomerId: 'cust-1' } } })).statusCode).toBe(202);
    expect(ingest.mock.calls[0][0].customer.contactConsent).toBeUndefined();
  });

  it('does not call the observer for duplicates and delegates monetary success only to OutcomeObserver', async () => {
    const ingest = vi.fn(async () => ({ created: false, deduplicated: true, event: { id: 'event-1', receivedAt: new Date() } }));
    const observer = { observeMerchantEvent: vi.fn() };
    const app = buildServer({ checkDbConnection: async () => true, merchantEventIngestionService: { ingestEvent: ingest } as any, merchantEventOutcomeObserver: observer as any }); apps.push(app);
    const duplicate = await app.inject({ method: 'POST', url: '/merchant-events', headers: headers(), payload: { ...valid, eventType: 'CHECKOUT_COMPLETED' } });
    expect(duplicate.json().deduplicated).toBe(true);
    expect(observer.observeMerchantEvent).not.toHaveBeenCalled();
  });

  it('hands a newly persisted monetary success to OutcomeObserver, never directly to a case writer', async () => {
    const ingest = vi.fn(async () => ({ created: true, deduplicated: false, event: { id: 'event-success', receivedAt: new Date() } }));
    const observer = { observeMerchantEvent: vi.fn(async () => ({ observed: false })) };
    const app = buildServer({ checkDbConnection: async () => true, merchantEventIngestionService: { ingestEvent: ingest } as any, merchantEventOutcomeObserver: observer as any }); apps.push(app);
    const result = await app.inject({ method: 'POST', url: '/merchant-events', headers: headers(), payload: { ...valid, eventType: 'CHECKOUT_COMPLETED' } });
    expect(result.statusCode).toBe(202);
    expect(observer.observeMerchantEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'CHECKOUT_COMPLETED' }), 'event-success');
  });
});
