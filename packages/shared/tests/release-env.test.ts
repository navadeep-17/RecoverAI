import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

const testEnv = { NODE_ENV: 'test', AI_PROVIDER: 'mock' };

describe('release environment configuration', () => {
  it('allows optional Razorpay Test Mode only when the keypair is complete', () => {
    expect(loadEnv(testEnv).RAZORPAY_KEY_ID).toBeUndefined();
    expect(loadEnv({ ...testEnv, RAZORPAY_KEY_ID: 'rzp_test_placeholder', RAZORPAY_KEY_SECRET: 'test-secret' }).RAZORPAY_KEY_ID).toBe('rzp_test_placeholder');
  });

  it('rejects live and partial Razorpay configuration without exposing a secret', () => {
    expect(() => loadEnv({ ...testEnv, RAZORPAY_KEY_ID: 'rzp_live_example', RAZORPAY_KEY_SECRET: 'not-disclosed' })).toThrow('live Razorpay keys');
    expect(() => loadEnv({ ...testEnv, RAZORPAY_KEY_ID: 'rzp_test_example' })).toThrow('must be configured together');
    expect(() => loadEnv({ ...testEnv, RAZORPAY_KEY_SECRET: 'not-disclosed' })).toThrow('must be configured together');
  });
});
