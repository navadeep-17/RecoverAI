import { describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { EnvConfig } from '@recoverai/shared';
import { buildTestServer, testAuthEnv } from './test-server.js';

const headers = (merchantId = 'merchant-a') => ({
  'x-merchant-id': merchantId,
  'x-user-id': 'user-a',
  'x-user-role': Role.MERCHANT_ADMIN,
});

const configuredEnv = {
  ...testAuthEnv,
  AI_PROVIDER: 'gemini',
  GEMINI_API_KEY: 'must-never-be-returned',
  RAZORPAY_KEY_ID: 'rzp_test_must-never-be-returned',
  RAZORPAY_KEY_SECRET: 'must-never-be-returned',
  RAZORPAY_WEBHOOK_SECRET: 'must-never-be-returned',
  RAZORPAY_TEST_MERCHANT_ID: 'merchant-a',
} as EnvConfig;

describe('integration status route', () => {
  it('requires an authenticated principal', async () => {
    const app = buildTestServer({ env: configuredEnv });
    const response = await app.inject({ method: 'GET', url: '/integrations/status' });
    expect(response.statusCode).toBe(401);
  });

  it('returns only non-secret configured status for the bound merchant', async () => {
    const app = buildTestServer({ env: configuredEnv });
    const response = await app.inject({
      method: 'GET',
      url: '/integrations/status',
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      razorpay: {
        mode: 'TEST',
        configured: true,
        paymentLinksEnabled: true,
        webhooksConfigured: true,
      },
      ai: { provider: 'gemini' },
    });
    expect(response.body).not.toContain('must-never-be-returned');
    expect(response.body).not.toMatch(/keyId|keySecret|webhookSecret|apiKey/i);
  });

  it("does not report another merchant's bound integration as configured", async () => {
    const app = buildTestServer({ env: configuredEnv });
    const response = await app.inject({
      method: 'GET',
      url: '/integrations/status',
      headers: headers('merchant-b'),
    });
    expect(response.json().razorpay).toEqual({
      mode: 'TEST',
      configured: false,
      paymentLinksEnabled: false,
      webhooksConfigured: false,
    });
  });

  it('reports optional absent Razorpay configuration as not configured', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: '/integrations/status',
      headers: headers(),
    });
    expect(response.json()).toMatchObject({
      razorpay: {
        mode: 'TEST',
        configured: false,
        paymentLinksEnabled: false,
        webhooksConfigured: false,
      },
      ai: { provider: 'mock' },
    });
  });
});
