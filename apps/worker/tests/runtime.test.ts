import { describe, expect, it, vi } from 'vitest';
import { bootstrapWorker, composeWorkerRuntime, WorkerRuntime } from '../src/runtime.js';

function runtime(worker: { start: () => Promise<void>; stop: () => Promise<void> }): WorkerRuntime {
  return { worker, closeDatabase: vi.fn(async () => {}) };
}

describe('worker executable runtime bootstrap', () => {
  it('starts the injected RecoveryWorkerService runtime', async () => {
    const worker = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const app = runtime(worker);
    const boot = await bootstrapWorker({ runtime: app, installSignalHandlers: false });
    expect(worker.start).toHaveBeenCalledTimes(1);
    await boot.shutdown();
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(app.closeDatabase as any).toHaveBeenCalledTimes(1);
  });

  it('fails startup visibly and closes resources', async () => {
    const worker = { start: vi.fn(async () => { throw new Error('pg-boss unavailable'); }), stop: vi.fn(async () => {}) };
    const app = runtime(worker);
    await expect(bootstrapWorker({ runtime: app, installSignalHandlers: false })).rejects.toThrow('pg-boss unavailable');
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(app.closeDatabase as any).toHaveBeenCalledTimes(1);
  });

  it('makes graceful shutdown idempotent', async () => {
    const worker = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const app = runtime(worker);
    const boot = await bootstrapWorker({ runtime: app, installSignalHandlers: false });
    await Promise.all([boot.shutdown(), boot.shutdown()]);
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(app.closeDatabase as any).toHaveBeenCalledTimes(1);
  });

  it('handles SIGTERM through the same one-time shutdown path', async () => {
    const worker = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const app = runtime(worker);
    await bootstrapWorker({ runtime: app });
    process.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(app.closeDatabase as any).toHaveBeenCalledTimes(1);
  });

  it('composes Gemini in production and rejects unsupported and fake-production LLM configuration', () => {
    expect(() => composeWorkerRuntime({ NODE_ENV: 'production', AI_PROVIDER: 'mock' } as any)).toThrow(/development\/test-only/);
    expect(() => composeWorkerRuntime({ NODE_ENV: 'development', AI_PROVIDER: 'openai' } as any)).toThrow(/unsupported/);
    expect(() => composeWorkerRuntime({ NODE_ENV: 'production', AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-test', DATABASE_URL: 'postgresql://x', PG_BOSS_SCHEMA: 'pgboss', LOG_LEVEL: 'error' } as any)).not.toThrow();
  });
});
