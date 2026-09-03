import { describe, expect, it, vi } from 'vitest';
import { Role } from '@prisma/client';
import { buildTestServer as buildServer } from './test-server.js';

const merchantA = 'merchant-a';
const merchantB = 'merchant-b';
const headers = (merchantId = merchantA) => ({ 'x-merchant-id': merchantId, 'x-user-id': 'user-a', 'x-user-role': Role.MERCHANT_ADMIN });

describe('case read routes', () => {
  it('returns 401 rather than a server error when case routes have no principal', async () => {
    const getRevenueRadarMetrics = vi.fn();
    const listCases = vi.fn();
    const app = buildServer({ checkDbConnection: async () => true, caseRepo: { getRevenueRadarMetrics, listCases } as any, auditRepo: {} as any });

    const [metrics, cases] = await Promise.all([
      app.inject({ method: 'GET', url: '/cases/metrics' }),
      app.inject({ method: 'GET', url: '/cases' }),
    ]);

    expect(metrics.statusCode).toBe(401);
    expect(cases.statusCode).toBe(401);
    expect(metrics.json()).toEqual({ error: 'UNAUTHORIZED: No authenticated principal present' });
    expect(cases.json()).toEqual({ error: 'UNAUTHORIZED: No authenticated principal present' });
    expect(getRevenueRadarMetrics).not.toHaveBeenCalled();
    expect(listCases).not.toHaveBeenCalled();
  });

  it('uses a tenant-scoped full-dataset metrics method rather than paginated cases', async () => {
    const getRevenueRadarMetrics = vi.fn(async (merchantId: string) => ({ revenueAtRisk: merchantId === merchantA ? '15000.00' : '0.00', verifiedRecovered: '0.30', activeRecoveries: 51, needsReview: 1, riskTypeBreakdown: { PAYMENT_FAILURE: { count: 51, amountAtRisk: '15000.00' } }, statusBreakdown: { OPEN: 50, NEEDS_REVIEW: 1 } }));
    const listCases = vi.fn();
    const app = buildServer({ checkDbConnection: async () => true, caseRepo: { getRevenueRadarMetrics, listCases } as any, auditRepo: {} as any });
    const response = await app.inject({ method: 'GET', url: '/cases/metrics', headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ revenueAtRisk: '15000.00', activeRecoveries: 51 });
    expect(getRevenueRadarMetrics).toHaveBeenCalledWith(merchantA);
    expect(listCases).not.toHaveBeenCalled();
  });

  it('keeps metrics tenant-scoped', async () => {
    const getRevenueRadarMetrics = vi.fn(async (merchantId: string) => ({ revenueAtRisk: merchantId === merchantA ? '1.00' : '999.00', verifiedRecovered: '0.00', activeRecoveries: 1, needsReview: 0, riskTypeBreakdown: {}, statusBreakdown: { OPEN: 1 } }));
    const app = buildServer({ checkDbConnection: async () => true, caseRepo: { getRevenueRadarMetrics } as any, auditRepo: {} as any });
    const response = await app.inject({ method: 'GET', url: '/cases/metrics', headers: headers(merchantB) });
    expect(response.json().revenueAtRisk).toBe('999.00');
    expect(getRevenueRadarMetrics).toHaveBeenCalledWith(merchantB);
  });

  it('returns minimized list DTOs rather than raw Prisma records', async () => {
    const listCases = vi.fn(async () => [{ id: 'case-1', customerId: 'customer-1', riskType: 'PAYMENT_FAILURE', amountAtRisk: { toString: () => '10.00' }, recoveredAmount: null, currency: 'INR', status: 'OPEN', openedAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-02'), contextJson: { secret: 'never exposed' }, merchantId: merchantA, customer: { id: 'customer-1', name: 'Ada', email: 'ada@example.test', passwordHash: 'never exposed' } }]);
    const app = buildServer({ checkDbConnection: async () => true, caseRepo: { listCases } as any, auditRepo: {} as any });
    const response = await app.inject({ method: 'GET', url: '/cases', headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().cases[0]).toEqual({ id: 'case-1', customerId: 'customer-1', riskType: 'PAYMENT_FAILURE', amountAtRisk: '10.00', recoveredAmount: null, currency: 'INR', status: 'OPEN', openedAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z', customer: { id: 'customer-1', name: 'Ada', email: 'ada@example.test' } });
  });

  it('returns only safe persisted decision facts and the authoritative recovery winner on the tenant-scoped detail route', async () => {
    const getCaseById = vi.fn(async (merchantId: string) => merchantId === merchantA ? { id: 'case-1', customerId: 'customer-1', riskType: 'PAYMENT_FAILURE', amountAtRisk: { toString: () => '10.00' }, recoveredAmount: { toString: () => '10.00' }, currency: 'INR', status: 'RECOVERED', openedAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-02'), contextJson: { verifiedPaymentFailureCode: 'CARD_EXPIRED', cardLast4: '4242', webhookSecret: 'never exposed as a dedicated field' }, customer: { id: 'customer-1', name: 'Ada', email: 'ada@example.test', contactConsent: null, optedOut: false }, recoveryOutcome: { id: 'winner-1', actionId: null, amountRecovered: { toString: () => '10.00' }, outcomeType: 'PAYMENT_SUCCEEDED', detailsJson: { secret: 'never exposed' } }, planVersions: [], actions: [], outcomes: [] } : null);
    const listByCase = vi.fn(async () => []);
    const app = buildServer({ checkDbConnection: async () => true, caseRepo: { getCaseById } as any, auditRepo: { listByCase } as any });
    const response = await app.inject({ method: 'GET', url: '/cases/case-1', headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().case).toMatchObject({ contextJson: { verifiedPaymentFailureCode: 'CARD_EXPIRED', cardLast4: '4242' }, customer: { id: 'customer-1', contactConsent: null, optedOut: false }, recoveryOutcome: { id: 'winner-1', actionId: null, amountRecovered: '10.00', outcomeType: 'PAYMENT_SUCCEEDED' } });
    expect(response.json().case.contextJson.webhookSecret).toBeUndefined();
    expect(getCaseById).toHaveBeenCalledWith(merchantA, 'case-1');
  });
});
