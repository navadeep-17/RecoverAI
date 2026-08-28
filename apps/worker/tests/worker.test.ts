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
      work: async () => 'mock_work_id',
      send: async () => 'mock_send_id',
    } as unknown as PgBoss;

    const worker = new RecoveryWorkerService({ bossInstance: mockBoss });
    await worker.start();
    expect(worker.getStatus().isRunning).toBe(true);
    expect(worker.getStatus().hasBossInstance).toBe(true);

    await worker.stop();
    expect(worker.getStatus().isRunning).toBe(false);
  });

  it('PgBossJobScheduler transitions ScheduledJob to SCHEDULED with pgBossJobId on successful dispatch', async () => {
    let jobRecord: any = {
      id: 'job_local_01',
      merchantId: 'mch_01',
      jobType: 'CHECKOUT_ABANDONMENT_CHECK',
      status: 'PENDING_DISPATCH',
      pgBossJobId: null,
    };

    const mockJobRepo = {
      createJob: async (params: any) => {
        jobRecord = {
          id: 'job_local_01',
          status: 'PENDING_DISPATCH',
          ...params,
        };
        return jobRecord;
      },
      updateJobStatus: async (merchantId: string, jobId: string, status: string, pgBossJobId?: string) => {
        jobRecord.status = status;
        if (pgBossJobId) jobRecord.pgBossJobId = pgBossJobId;
        return jobRecord;
      },
    };

    const mockBoss = {
      send: async () => 'pg_boss_uuid_123',
    };

    const scheduler = new (await import('../src/scheduler.js')).PgBossJobScheduler(
      mockBoss as any,
      mockJobRepo as any,
    );

    const result = await scheduler.schedule({
      merchantId: 'mch_01',
      jobType: 'CHECKOUT_ABANDONMENT_CHECK',
      scheduledFor: new Date(Date.now() + 1800000),
      payloadJson: { test: true },
    });

    expect(result.id).toBe('job_local_01');
    expect(result.pgBossJobId).toBe('pg_boss_uuid_123');
    expect(jobRecord.status).toBe('SCHEDULED');
    expect(jobRecord.pgBossJobId).toBe('pg_boss_uuid_123');
  });

  it('PgBossJobScheduler transitions ScheduledJob to FAILED and throws JobSchedulingError when boss.send fails', async () => {
    let jobRecord: any = {
      id: 'job_local_02',
      merchantId: 'mch_01',
      jobType: 'INVOICE_OVERDUE_CHECK',
      status: 'PENDING_DISPATCH',
      pgBossJobId: null,
    };

    const mockJobRepo = {
      createJob: async (params: any) => {
        jobRecord = {
          id: 'job_local_02',
          status: 'PENDING_DISPATCH',
          ...params,
        };
        return jobRecord;
      },
      updateJobStatus: async (merchantId: string, jobId: string, status: string) => {
        jobRecord.status = status;
        return jobRecord;
      },
    };

    const mockBoss = {
      send: async () => {
        throw new Error('Connection refused to pg-boss broker');
      },
    };

    const scheduler = new (await import('../src/scheduler.js')).PgBossJobScheduler(
      mockBoss as any,
      mockJobRepo as any,
    );

    await expect(
      scheduler.schedule({
        merchantId: 'mch_01',
        jobType: 'INVOICE_OVERDUE_CHECK',
        scheduledFor: new Date(Date.now() + 86400000),
        payloadJson: { test: true },
      }),
    ).rejects.toThrow(/Failed to schedule durable job "INVOICE_OVERDUE_CHECK"/);

    expect(jobRecord.status).toBe('FAILED');
  });
});
