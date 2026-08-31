import { defineConfig } from '@playwright/test';

const databaseUrl = 'postgresql://recoverai:recoverai_secret@localhost:5432/recoverai?schema=public';
const commonEnv = {
  DATABASE_URL: databaseUrl,
  PG_BOSS_SCHEMA: 'pgboss',
};

// Playwright workers seed and clean up disposable fixtures directly, so they
// need the same explicit database environment as the spawned services.
process.env.DATABASE_URL = commonEnv.DATABASE_URL;
process.env.PG_BOSS_SCHEMA = commonEnv.PG_BOSS_SCHEMA;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 } },
  webServer: [
    {
      command: 'npm run --workspace=@recoverai/api start',
      url: 'http://127.0.0.1:3000/ready',
      reuseExistingServer: !process.env.CI,
      env: { ...commonEnv, PORT: '3000', HOST: '127.0.0.1', CORS_ORIGIN: 'http://127.0.0.1:5173', AI_PROVIDER: 'mock', LOG_LEVEL: 'error', SESSION_SECRET: 'phase_9c_playwright_session_secret' },
    },
    {
      command: 'npm run --workspace=@recoverai/web dev -- --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      env: { VITE_API_BASE_URL: 'http://127.0.0.1:3000', VITE_DEV_MERCHANT_ID: 'phase-9c-e2e-merchant', VITE_DEV_USER_ID: 'phase-9c-e2e-admin', VITE_DEV_USER_ROLE: 'MERCHANT_ADMIN' },
    },
  ],
});
