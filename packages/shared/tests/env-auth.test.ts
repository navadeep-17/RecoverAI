import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

const production = {
  NODE_ENV: 'production', DATABASE_URL: 'postgresql://recoverai:recoverai_secret@localhost:5432/recoverai?schema=public',
  SESSION_SECRET: 'production-session-secret-with-at-least-32-characters', CORS_ORIGIN: 'https://app.recoverai.test',
  AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key', AUTH_MODE: 'trusted_headers', AUTH_TRUST_SECRET: 'trusted-gateway-secret-with-at-least-32-characters',
};

describe('authentication environment boundary', () => {
  it('rejects production dev headers and missing trusted-gateway configuration', () => {
    expect(() => loadEnv({ ...production, AUTH_MODE: 'dev_headers' })).toThrow('AUTH_MODE');
    expect(() => loadEnv({ ...production, AUTH_TRUST_SECRET: undefined })).toThrow('AUTH_TRUST_SECRET');
  });

  it('rejects unsafe production CORS and accepts an explicit trusted configuration', () => {
    expect(() => loadEnv({ ...production, CORS_ORIGIN: '*' })).toThrow('CORS_ORIGIN');
    expect(loadEnv(production).AUTH_MODE).toBe('trusted_headers');
  });

  it('requires explicit development header mode', () => {
    expect(() => loadEnv({ NODE_ENV: 'development' })).toThrow('AUTH_MODE');
    expect(loadEnv({ NODE_ENV: 'development', AUTH_MODE: 'dev_headers' }).AUTH_MODE).toBe('dev_headers');
  });
});
