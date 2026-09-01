import { describe, it, expect, vi } from 'vitest';
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

  it('cleans up a real worker lifecycle when subscriber registration fails after pg-boss starts', async () => {
    const mockBoss = {
      start: vi.fn(async () => mockBoss as unknown as PgBoss),
      stop: vi.fn(async () => {}),
      on: vi.fn(() => mockBoss),
      work: vi.fn(async () => { throw new Error('subscriber registration failed'); }),
      send: vi.fn(async () => 'mock_send_id'),
    } as unknown as PgBoss;
    const worker = new RecoveryWorkerService({ bossInstance: mockBoss });

    await expect(worker.start()).rejects.toThrow('subscriber registration failed');
    expect((mockBoss.stop as any)).toHaveBeenCalledTimes(1);
    expect(worker.getStatus().isRunning).toBe(false);
    await worker.stop();
    expect((mockBoss.stop as any)).toHaveBeenCalledTimes(1);
  });

  it('fails a RECOVERY_ITERATION without falsely completing its ScheduledJob when orchestration throws', async () => {
    const handlers = new Map<string, (job: { data: unknown }) => Promise<void>>();
    const mockBoss = {
      start: vi.fn(async () => mockBoss as unknown as PgBoss),
      stop: vi.fn(async () => {}),
      on: vi.fn(() => mockBoss),
      work: vi.fn(async (name: string, handler: (job: { data: unknown }) => Promise<void>) => { handlers.set(name, handler); return name; }),
      send: vi.fn(async () => 'mock_send_id'),
    } as unknown as PgBoss;
    const scheduledJobRepo = {
      getJobById: vi.fn(async () => ({ id: 'job-iteration-1', merchantId: 'merchant-1', caseId: 'case-1', jobType: 'RECOVERY_ITERATION', payloadJson: { caseId: 'case-1', triggerKey: 'CASE_OPENED:case-1', triggerType: 'CASE_OPENED' } })),
      updateJobStatus: vi.fn(async () => ({})),
    };
    const orchestrator = { runIteration: vi.fn(async () => { throw new Error('deterministic orchestration failure'); }) };
    const worker = new RecoveryWorkerService({ bossInstance: mockBoss, scheduledJobRepo: scheduledJobRepo as any, orchestrator: orchestrator as any });
    await worker.start();

    await expect(handlers.get('RECOVERY_ITERATION')!({ data: { merchantId: 'merchant-1', caseId: 'case-1', jobRecordId: 'job-iteration-1', triggerKey: 'CASE_OPENED:case-1', triggerType: 'CASE_OPENED' } })).rejects.toThrow('deterministic orchestration failure');
    expect(orchestrator.runIteration).toHaveBeenCalledTimes(1);
    expect(scheduledJobRepo.updateJobStatus).not.toHaveBeenCalled();
    await worker.stop();
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
        return { created: true, job: jobRecord };
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
      scheduledFor: new Date(Date.now() + 60000),
      payloadJson: { checkoutId: 'chk_123' },
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
        return { created: true, job: jobRecord };
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
