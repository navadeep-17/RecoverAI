import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z
    .string()
    .default('postgresql://recoverai:recoverai_secret@localhost:5432/recoverai?schema=public'),
  PG_BOSS_SCHEMA: z.string().default('pgboss'),
  SESSION_SECRET: z.string().min(16).default('development_secret_must_be_overridden_in_prod'),
  AI_PROVIDER: z.enum(['mock', 'gemini', 'anthropic', 'openai']).default('mock'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
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
