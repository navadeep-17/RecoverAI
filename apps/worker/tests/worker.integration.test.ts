import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RecoveryWorkerService } from '../src/worker.js';
import { checkDatabaseConnection } from '@recoverai/db';

describe('pg-boss Real Integration Smoke Test', () => {
  let dbAvailable = false;
  let worker: RecoveryWorkerService | null = null;

  beforeAll(async () => {
    dbAvailable = await checkDatabaseConnection();
  });

  afterAll(async () => {
    if (worker && worker.getStatus().isRunning) {
      await worker.stop();
    }
  });

  it('connects to real PostgreSQL, initializes schema, and manages lifecycle', async () => {
    if (!dbAvailable) {
      console.warn('PostgreSQL database not available in local environment; test will run in CI');
      expect(true).toBe(true);
      return;
    }

    worker = new RecoveryWorkerService({
      schema: 'pgboss_smoke_test',
    });

    await worker.start();
    expect(worker.getStatus().isRunning).toBe(true);
    expect(worker.getStatus().hasBossInstance).toBe(true);

    const boss = worker.getBoss();
    expect(boss).not.toBeNull();

    // Send a test job into pg-boss
    const jobId = await boss!.send('smoke-test-queue', { test: true });
    expect(typeof jobId).toBe('string');

    // Gracefully stop worker
    await worker.stop();
    expect(worker.getStatus().isRunning).toBe(false);
  });
});
