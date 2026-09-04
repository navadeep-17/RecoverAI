import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const runtimeKeys = [
  'NODE_ENV',
  'PORT',
  'HOST',
  'CORS_ORIGIN',
  'DATABASE_URL',
  'PG_BOSS_SCHEMA',
  'SESSION_SECRET',
  'AUTH_MODE',
  'AUTH_TRUST_SECRET',
  'AI_PROVIDER',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'RAZORPAY_TEST_MERCHANT_ID',
  'LOG_LEVEL',
  'VITE_API_BASE_URL',
  'VITE_DEV_MERCHANT_ID',
  'VITE_DEV_USER_ID',
  'VITE_DEV_USER_ROLE',
] as const;

describe('.env.example', () => {
  it('documents every API, worker, provider, queue, and web runtime key', () => {
    const example = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
    for (const key of runtimeKeys) {
      expect(example, `${key} is missing from .env.example`).toMatch(
        new RegExp(`^#?\\s*${key}=`, 'm'),
      );
    }
    expect(example).toContain('AI_PROVIDER=mock');
    expect(example).not.toMatch(/^\s*RAZORPAY_KEY_ID=rzp_live_/m);
  });
});
