import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'build', 'e2e/**'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      '@recoverai/shared': path.resolve(__dirname, './packages/shared/src'),
      '@recoverai/db': path.resolve(__dirname, './packages/db/src'),
      '@recoverai/core': path.resolve(__dirname, './packages/core/src'),
      '@recoverai/policy': path.resolve(__dirname, './packages/policy/src'),
      '@recoverai/integrations': path.resolve(__dirname, './packages/integrations/src'),
      '@recoverai/evaluation': path.resolve(__dirname, './packages/evaluation/src'),
    },
  },
});
