import { describe, it, expect } from 'vitest';
import { RecoveryWorkerService } from '../src/worker.js';
import PgBoss from 'pg-boss';

describe('RecoveryWorkerService Unit Tests', () => {
  it('Initializes with correct default status', () => {
    const worker = new RecoveryWorkerService();
    const status = worker.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.hasBossInstance).toBe(false);
  });

  it('Supports mock boss dependency injection for unit testing', async () => {
    const mockBoss = {
      start: async () => mockBoss as unknown as PgBoss,
      stop: async () => {},
      on: () => mockBoss,
    } as unknown as PgBoss;

    const worker = new RecoveryWorkerService({ bossInstance: mockBoss });
    await worker.start();
    expect(worker.getStatus().isRunning).toBe(true);
    expect(worker.getStatus().hasBossInstance).toBe(true);

    await worker.stop();
    expect(worker.getStatus().isRunning).toBe(false);
  });
});
