import { describe, expect, it, vi } from 'vitest';
import { Role } from '@prisma/client';
import { buildServer } from '../src/server.js';

const merchantA = 'merchant-a';
const merchantB = 'merchant-b';
const headers = (merchantId = merchantA) => ({ 'x-merchant-id': merchantId, 'x-user-id': 'user-a', 'x-user-role': Role.MERCHANT_ADMIN });

describe('case read routes', () => {
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
});
