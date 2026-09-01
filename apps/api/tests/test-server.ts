import { EnvConfig } from '@recoverai/shared';
import { BuildServerOptions, buildServer } from '../src/server.js';

export const testAuthEnv = {
  NODE_ENV: 'test', AUTH_MODE: 'dev_headers', CORS_ORIGIN: 'http://localhost:5173', LOG_LEVEL: 'error',
} as EnvConfig;

export function buildTestServer(options: BuildServerOptions = {}) {
  return buildServer({ env: testAuthEnv, ...options });
}
