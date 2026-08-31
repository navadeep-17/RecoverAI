import { describe, expect, it, vi } from 'vitest';
import { Role } from '@prisma/client';
import { buildServer } from '../src/server.js';
import { resolveFrozenEvaluationArtifact } from '../src/routes/evaluation-routes.js';

const headers = (role = Role.MERCHANT_ADMIN, merchantId = 'merchant-a') => ({ 'x-merchant-id': merchantId, 'x-user-id': 'admin-a', 'x-user-role': role });
const config = { id: 'policy-1', merchantId: 'merchant-a', maxRetriesPerCase: 3, maxContactsPerCase: 3, maxActionsPerCase: 5, cooldownHoursBetweenActions: 24, highValueThreshold: { toFixed: () => '50000.00' }, minConfidenceThreshold: .65, reviewFirstMode: false, checkoutAbandonmentThresholdMinutes: 30, quietHoursStart: 21, quietHoursEnd: 9, quietHoursTimezone: 'Asia/Kolkata', maxRecoveryWindowDays: 30, overdueGracePeriodDays: 3, createdAt: new Date(), updatedAt: new Date() };

describe('policy and frozen evaluation routes', () => {
  it('returns tenant-scoped materialized policy defaults', async () => {
    const getOrCreateConfig = vi.fn(async (merchantId: string) => ({ ...config, merchantId }));
    const app = buildServer({ checkDbConnection: async () => true, policyConfigRepo: { getOrCreateConfig } as any, auditRepo: {} as any });
    const response = await app.inject({ method: 'GET', url: '/policy', headers: headers() });
    expect(response.statusCode).toBe(200); expect(response.json().policy.highValueThreshold).toBe('50000.00'); expect(getOrCreateConfig).toHaveBeenCalledWith('merchant-a');
  });
  it('requires merchant admin, rejects unknown fields, validates thresholds, and audits a safe patch', async () => {
    const updateConfig = vi.fn(async (_merchant: string, patch: any) => ({ ...config, ...patch })); const record = vi.fn(async () => ({}));
    const app = buildServer({ checkDbConnection: async () => true, policyConfigRepo: { updateConfig } as any, auditRepo: { record } as any });
    expect((await app.inject({ method: 'PATCH', url: '/policy', headers: headers(Role.REVIEWER), payload: { maxRetriesPerCase: 4 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/policy', headers: headers(), payload: { merchantId: 'other' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/policy', headers: headers(), payload: { highValueThreshold: '-1' } })).statusCode).toBe(400);
    const response = await app.inject({ method: 'PATCH', url: '/policy', headers: headers(), payload: { maxRetriesPerCase: 4 } });
    expect(response.statusCode).toBe(200); expect(updateConfig).toHaveBeenCalledWith('merchant-a', { maxRetriesPerCase: 4 }); expect(record).toHaveBeenCalledWith('merchant-a', expect.objectContaining({ eventType: 'POLICY_CONFIG_UPDATED', inputSummaryJson: { changedFields: ['maxRetriesPerCase'] } }));
  });
  it('returns the read-only frozen benchmark summary', async () => {
    const app = buildServer({ checkDbConnection: async () => true }); const response = await app.inject({ method: 'GET', url: '/evaluation', headers: headers() });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ frozen: true, scenarioCount: 500, evaluatorFingerprint: 'sha256:f07508e41e4c7a29a1a3c09b2206fa5d7c8cb2dca20a75de9d59e927f8bb8e96' }); expect(response.json().results.map((item: { strategy: string }) => item.strategy)).toEqual(['NO_INTERVENTION', 'NAIVE_RECOVERY', 'RULE_BASED', 'RULE_BASED_WITH_POLICY', 'RECOVERAI', 'POLICY_AWARE_ORACLE']);
  });
  it('resolves the frozen artifact through the evaluation workspace package, not cwd', async () => {
    const packageJson = require.resolve('@recoverai/evaluation/package.json');
    expect(resolveFrozenEvaluationArtifact(packageJson)).toMatch(/[\\/]packages[\\/]evaluation[\\/]results[\\/]heldout-summary\.json$/);
    const app = buildServer({ checkDbConnection: async () => true });
    const response = await app.inject({ method: 'GET', url: '/evaluation', headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().results.map((item: { strategy: string }) => item.strategy)).toEqual(['NO_INTERVENTION', 'NAIVE_RECOVERY', 'RULE_BASED', 'RULE_BASED_WITH_POLICY', 'RECOVERAI', 'POLICY_AWARE_ORACLE']);
  });
  it('classifies missing principal and internal repository or audit failures safely', async () => {
    const failingPolicyRepo = { updateConfig: vi.fn(async () => { throw new Error('database connection detail'); }) } as any;
    const app = buildServer({ checkDbConnection: async () => true, policyConfigRepo: failingPolicyRepo, auditRepo: {} as any });
    expect((await app.inject({ method: 'PATCH', url: '/policy', payload: { maxRetriesPerCase: 4 } })).statusCode).toBe(401);
    const internal = await app.inject({ method: 'PATCH', url: '/policy', headers: headers(), payload: { maxRetriesPerCase: 4 } });
    expect(internal.statusCode).toBe(500); expect(internal.json().error).toBe('Unable to update policy configuration');

    const auditFailure = buildServer({ checkDbConnection: async () => true, policyConfigRepo: { updateConfig: vi.fn(async () => config) } as any, auditRepo: { record: vi.fn(async () => { throw new Error('audit unavailable'); }) } as any });
    const audited = await auditFailure.inject({ method: 'PATCH', url: '/policy', headers: headers(), payload: { maxRetriesPerCase: 4 } });
    expect(audited.statusCode).toBe(500); expect(audited.json().error).toBe('Unable to update policy configuration');
  });
});
