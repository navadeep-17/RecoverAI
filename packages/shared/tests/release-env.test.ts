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
  it('allows optional Razorpay Test Mode only when the keypair is complete', () => {
    expect(loadEnv(testEnv).RAZORPAY_KEY_ID).toBeUndefined();
    expect(loadEnv({ ...testEnv, RAZORPAY_KEY_ID: 'rzp_test_placeholder', RAZORPAY_KEY_SECRET: 'test-secret' }).RAZORPAY_KEY_ID).toBe('rzp_test_placeholder');
  });

  it('rejects live, unrecognized, and partial Razorpay configuration without exposing a secret', () => {
    expect(() => loadEnv({ ...testEnv, RAZORPAY_KEY_ID: 'rzp_live_example', RAZORPAY_KEY_SECRET: 'not-disclosed' })).toThrow('Razorpay Test Mode key');
    expect(() => loadEnv({ ...testEnv, RAZORPAY_KEY_ID: 'rp_unknown_example', RAZORPAY_KEY_SECRET: 'not-disclosed' })).toThrow('Razorpay Test Mode key');
    expect(() => loadEnv({ ...testEnv, RAZORPAY_KEY_ID: 'rzp_test_example' })).toThrow('must be configured together');
    expect(() => loadEnv({ ...testEnv, RAZORPAY_KEY_SECRET: 'not-disclosed' })).toThrow('must be configured together');
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
