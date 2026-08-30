export * from './worker.js';
export * from './scheduler.js';
export * from './runtime.js';

import { bootstrapWorker } from './runtime.js';

if (process.env.NODE_ENV !== 'test') {
  void bootstrapWorker().catch((error) => {
    // Do not call process.exit(): startup cleanup must finish first.
    console.error('Failed to start RecoverAI worker runtime', error);
    process.exitCode = 1;
  });
}
