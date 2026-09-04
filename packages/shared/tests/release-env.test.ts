import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

const testEnv = { NODE_ENV: 'test', AI_PROVIDER: 'mock' };
const productionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://recoverai:recoverai_secret@localhost:5432/recoverai?schema=public',
  SESSION_SECRET: 'production-session-secret-with-at-least-32-characters',
  CORS_ORIGIN: 'https://app.recoverai.test',
  AUTH_MODE: 'trusted_headers',
  AUTH_TRUST_SECRET: 'trusted-gateway-secret-with-at-least-32-characters',
};

describe('release environment configuration', () => {
  it('allows absent or complete Razorpay Test Mode configuration', () => {
    expect(loadEnv(testEnv).RAZORPAY_KEY_ID).toBeUndefined();
    expect(
      loadEnv({
        ...testEnv,
        RAZORPAY_KEY_ID: 'rzp_test_placeholder',
        RAZORPAY_KEY_SECRET: 'test-secret',
        RAZORPAY_TEST_MERCHANT_ID: 'merchant-test',
        RAZORPAY_WEBHOOK_SECRET: 'webhook-secret',
      }).RAZORPAY_KEY_ID,
    ).toBe('rzp_test_placeholder');
  });

  it('rejects a key pair without the webhook secret', () => {
    expect(() =>
      loadEnv({
        ...testEnv,
        RAZORPAY_KEY_ID: 'rzp_test_example',
        RAZORPAY_KEY_SECRET: 'not-disclosed',
        RAZORPAY_TEST_MERCHANT_ID: 'merchant-test',
      }),
    ).toThrow('RAZORPAY_WEBHOOK_SECRET');
  });

  it('rejects a key pair without merchant binding', () => {
    expect(() =>
      loadEnv({
        ...testEnv,
        RAZORPAY_KEY_ID: 'rzp_test_example',
        RAZORPAY_KEY_SECRET: 'not-disclosed',
        RAZORPAY_WEBHOOK_SECRET: 'webhook-secret',
      }),
    ).toThrow('RAZORPAY_TEST_MERCHANT_ID');
  });

  it('rejects live, unrecognized, and other partial Razorpay configuration without exposing secrets', () => {
    const complete = {
      ...testEnv,
      RAZORPAY_KEY_SECRET: 'not-disclosed',
      RAZORPAY_TEST_MERCHANT_ID: 'merchant-test',
      RAZORPAY_WEBHOOK_SECRET: 'webhook-secret',
    };
    expect(() => loadEnv({ ...complete, RAZORPAY_KEY_ID: 'rzp_live_example' })).toThrow('Razorpay Test Mode key');
    expect(() => loadEnv({ ...complete, RAZORPAY_KEY_ID: 'rp_unknown_example' })).toThrow('Razorpay Test Mode key');
    expect(() => loadEnv({ ...testEnv, RAZORPAY_KEY_ID: 'rzp_test_example' })).toThrow('is required when Razorpay Test Mode is configured');
    expect(() => loadEnv({ ...testEnv, RAZORPAY_KEY_SECRET: 'not-disclosed' })).toThrow('is required when Razorpay Test Mode is configured');
  });

  it('requires an explicit real AI provider in production', () => {
    expect(() => loadEnv(productionEnv)).toThrow('must explicitly be gemini');
    expect(() => loadEnv({ ...productionEnv, AI_PROVIDER: 'mock' })).toThrow('must explicitly be gemini');
    expect(() => loadEnv({ ...productionEnv, AI_PROVIDER: 'gemini' })).toThrow('GEMINI_API_KEY');
    expect(loadEnv({ ...productionEnv, AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key' }).AI_PROVIDER).toBe('gemini');
  });

  it('keeps explicitly configured mock usable in development and test', () => {
    expect(loadEnv(testEnv).AI_PROVIDER).toBe('mock');
    expect(loadEnv({ NODE_ENV: 'development', AUTH_MODE: 'dev_headers', AI_PROVIDER: 'mock' }).AI_PROVIDER).toBe('mock');
  });
});
