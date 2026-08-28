import { describe, it, expect } from 'vitest';
import { RecoveryWorkerService } from '../src/worker.js';

describe('RecoveryWorkerService', () => {
  it('Initializes with correct default status', () => {
    const worker = new RecoveryWorkerService();
    const status = worker.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.hasBossInstance).toBe(false);
  });

  it('Can start and stop safely in test mode', async () => {
    const worker = new RecoveryWorkerService();
    await worker.start();
    expect(worker.getStatus().isRunning).toBe(true);
    expect(worker.getStatus().hasBossInstance).toBe(true);
    await worker.stop();
    expect(worker.getStatus().isRunning).toBe(false);
  });
});
