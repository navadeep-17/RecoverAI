import { describe, expect, it, vi } from 'vitest';
import { Role } from '@recoverai/db';
import { EnvConfig } from '@recoverai/shared';
import { buildServer } from '../src/server.js';
import { createTrustedPrincipalSignature, PrincipalResolver } from '../src/auth/principal.js';

const candidate = { merchantId: 'merchant-a', userId: 'user-a', role: Role.MERCHANT_ADMIN };
const devEnv = { NODE_ENV: 'development', AUTH_MODE: 'dev_headers', CORS_ORIGIN: 'http://localhost:5173', LOG_LEVEL: 'error' } as EnvConfig;
const trustedSecret = 'trusted-gateway-secret-with-at-least-32-characters';
const trustedEnv = { NODE_ENV: 'production', AUTH_MODE: 'trusted_headers', AUTH_TRUST_SECRET: trustedSecret, CORS_ORIGIN: 'https://app.recoverai.test', LOG_LEVEL: 'error' } as EnvConfig;
const headers = (overrides: Record<string, string> = {}) => ({ 'x-merchant-id': candidate.merchantId, 'x-user-id': candidate.userId, 'x-user-role': candidate.role, ...overrides });

function appFor(env: EnvConfig, resolver: PrincipalResolver) {
  return buildServer({ env, principalResolver: resolver, checkDbConnection: async () => true, caseRepo: { getRevenueRadarMetrics: vi.fn(async () => ({ activeRecoveries: 0 })) } as any, auditRepo: {} as any });
}

describe('explicit authentication boundary', () => {
  it('accepts explicit development headers only after membership resolution', async () => {
    const resolve = vi.fn(async () => candidate);
    const app = appFor(devEnv, { resolve });
    const response = await app.inject({ method: 'GET', url: '/cases/metrics', headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith(candidate);
    await app.close();
  });

  it.each([
    ['missing merchant', { 'x-merchant-id': '' }],
    ['missing user', { 'x-user-id': '' }],
    ['missing role', { 'x-user-role': '' }],
    ['invalid role', { 'x-user-role': 'ROOT_ADMIN' }],
  ])('rejects %s without an implicit admin principal', async (_name, override) => {
    const resolve = vi.fn(async () => candidate);
    const app = appFor(devEnv, { resolve });
    const response = await app.inject({ method: 'GET', url: '/cases/metrics', headers: headers(override) });
    expect(response.statusCode).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(['cross-merchant membership spoof', 'user is not a merchant member', 'claimed role differs from membership'])('rejects %s', async () => {
    const app = appFor(devEnv, { resolve: async () => null });
    const response = await app.inject({ method: 'GET', url: '/cases/metrics', headers: headers() });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('requires a valid trusted-gateway signature in production mode', async () => {
    const app = appFor(trustedEnv, { resolve: async () => candidate });
    const rejected = await app.inject({ method: 'GET', url: '/cases/metrics', headers: headers() });
    const accepted = await app.inject({ method: 'GET', url: '/cases/metrics', headers: headers({ 'x-recoverai-auth-signature': createTrustedPrincipalSignature(candidate, trustedSecret) }) });
    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    await app.close();
  });
});
