import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  AUTH_MODE: z.enum(['dev_headers', 'trusted_headers']).optional(),
  AUTH_TRUST_SECRET: z.string().min(32).optional(),
  DATABASE_URL: z
    .string()
    .default('postgresql://recoverai:recoverai_secret@localhost:5432/recoverai?schema=public'),
  PG_BOSS_SCHEMA: z.string().default('pgboss'),
  SESSION_SECRET: z.string().min(16).default('development_secret_must_be_overridden_in_prod'),
  // Gemini is the only real provider implemented by the worker runtime. Mock is
  // deliberately retained for explicitly configured local/test execution.
  AI_PROVIDER: z.enum(['mock', 'gemini']).default('mock'),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.6-flash'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Test-mode only. These remain optional so ordinary CI never needs private credentials.
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
  RAZORPAY_TEST_MERCHANT_ID: z.string().min(1).optional(),
}).superRefine((env, ctx) => {
  const hasRazorpayKeyId = Boolean(env.RAZORPAY_KEY_ID);
  const hasRazorpayKeySecret = Boolean(env.RAZORPAY_KEY_SECRET);
  if (hasRazorpayKeyId !== hasRazorpayKeySecret) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['RAZORPAY_KEY_ID'], message: 'and RAZORPAY_KEY_SECRET must be configured together' });
  }
  if (env.RAZORPAY_KEY_ID && !env.RAZORPAY_KEY_ID.startsWith('rzp_test_')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['RAZORPAY_KEY_ID'], message: 'must be a Razorpay Test Mode key (rzp_test_...); live and unrecognized keys are not supported' });
  }
  if (env.NODE_ENV === 'development' && env.AUTH_MODE !== 'dev_headers') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['AUTH_MODE'], message: 'must be dev_headers for local development' });
  }
  if (env.NODE_ENV === 'production') {
    if (env.AUTH_MODE !== 'trusted_headers') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['AUTH_MODE'], message: 'must be trusted_headers in production' });
    if (!env.AUTH_TRUST_SECRET) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['AUTH_TRUST_SECRET'], message: 'is required for trusted production headers' });
    if (env.CORS_ORIGIN === '*' || env.CORS_ORIGIN.includes('localhost')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGIN'], message: 'must be an explicit non-localhost production origin' });
    if (env.SESSION_SECRET === 'development_secret_must_be_overridden_in_prod') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SESSION_SECRET'], message: 'must be replaced in production' });
    if (env.AI_PROVIDER !== 'gemini') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['AI_PROVIDER'], message: 'must explicitly be gemini in production; mock is development/test-only' });
  }
  if (env.AI_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['GEMINI_API_KEY'], message: 'is required when AI_PROVIDER=gemini' });
  }
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function loadEnv(envObj: Record<string, unknown> = process.env): EnvConfig {
  const result = EnvSchema.safeParse(envObj);
  if (!result.success) {
    const errorMsg = result.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join(', ');
    throw new Error(`Invalid environment configuration: ${errorMsg}`);
  }
  return result.data;
}
