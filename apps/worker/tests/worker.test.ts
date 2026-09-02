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
    expect(scheduledJobRepo.updateJobStatus).toHaveBeenCalledWith('merchant-1', 'job-iteration-1', 'FAILED');
    await worker.stop();
  });

  it('marks a checkout timer FAILED when deterministic risk evaluation throws', async () => {
    const handlers = new Map<string, (job: { data: unknown }) => Promise<void>>();
    const mockBoss = {
      start: vi.fn(async () => mockBoss as unknown as PgBoss),
      stop: vi.fn(async () => {}),
      on: vi.fn(() => mockBoss),
      work: vi.fn(async (name: string, handler: (job: { data: unknown }) => Promise<void>) => { handlers.set(name, handler); return name; }),
    } as unknown as PgBoss;
    const scheduledJobRepo = { updateJobStatus: vi.fn(async () => ({})) };
    const riskDetector = { evaluateCheckoutTimer: vi.fn(async () => { throw new Error('checkout evaluation failed'); }) };
    const worker = new RecoveryWorkerService({ bossInstance: mockBoss, scheduledJobRepo: scheduledJobRepo as any, riskDetector: riskDetector as any });
    await worker.start();

    await expect(handlers.get('CHECKOUT_ABANDONMENT_CHECK')!({ data: { merchantId: 'merchant-1', checkoutSessionId: 'checkout-1', jobRecordId: 'job-checkout-1' } })).rejects.toThrow('checkout evaluation failed');
    expect(scheduledJobRepo.updateJobStatus).toHaveBeenCalledWith('merchant-1', 'job-checkout-1', 'FAILED');
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
      createJob: async (_merchantId: string, params: any) => {
        jobRecord = {
          id: 'job_local_01',
          merchantId: _merchantId,
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
      insert: async () => {},
      getJobById: async (id: string) => ({ id }),
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
    expect(result.pgBossJobId).toBe('job_local_01');
    expect(jobRecord.status).toBe('SCHEDULED');
    expect(jobRecord.pgBossJobId).toBe('job_local_01');
  });

  it('PgBossJobScheduler leaves an ambiguous dispatch repairable and throws JobSchedulingError', async () => {
    let jobRecord: any = {
      id: 'job_local_02',
      merchantId: 'mch_01',
      jobType: 'INVOICE_OVERDUE_CHECK',
      status: 'PENDING_DISPATCH',
      pgBossJobId: null,
    };

    const mockJobRepo = {
      createJob: async (_merchantId: string, params: any) => {
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
      insert: async () => {
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

    expect(jobRecord.status).toBe('PENDING_DISPATCH');
  });

  it('repairs a stale PENDING_DISPATCH row with one deterministic logical pg-boss identity', async () => {
    const jobRecord: any = {
      id: '2be8c270-6364-4a31-b4cc-aaef8897f051',
      merchantId: 'mch_01',
      caseId: 'case_01',
      jobKey: 'recovery-iteration:case_01:case-opened',
      jobType: 'RECOVERY_ITERATION',
      status: 'PENDING_DISPATCH',
      pgBossJobId: null,
      scheduledFor: new Date('2026-09-02T12:00:00.000Z'),
      payloadJson: { caseId: 'case_01', triggerKey: 'CASE_OPENED:case_01', triggerType: 'CASE_OPENED' },
    };
    const mockJobRepo = {
      createJob: vi.fn(async () => ({ created: false, job: jobRecord })),
      updateJobStatus: vi.fn(async (_merchantId: string, _jobId: string, status: string, pgBossJobId?: string) => {
        jobRecord.status = status;
        jobRecord.pgBossJobId = pgBossJobId || null;
        return jobRecord;
      }),
    };
    const inserted: any[][] = [];
    const mockBoss = {
      insert: vi.fn(async (jobs: any[]) => { inserted.push(jobs); }),
      getJobById: vi.fn(async (id: string) => ({ id })),
    };
    const scheduler = new (await import('../src/scheduler.js')).PgBossJobScheduler(mockBoss as any, mockJobRepo as any);
    const params = {
      merchantId: 'mch_01',
      caseId: 'case_01',
      jobKey: jobRecord.jobKey,
      jobType: 'RECOVERY_ITERATION',
      scheduledFor: jobRecord.scheduledFor,
      payloadJson: { caseId: 'case_01', triggerKey: 'CASE_OPENED:case_01', triggerType: 'CASE_OPENED' },
    };

    const [first, second] = await Promise.all([
      scheduler.schedule(params),
      scheduler.schedule({
        ...params,
        scheduledFor: new Date('2026-09-01T00:00:00.000Z'),
        payloadJson: { caseId: 'wrong-case', triggerKey: 'wrong-trigger', triggerType: 'CASE_OPENED' },
      }),
    ]);
    expect(first).toMatchObject({ id: jobRecord.id, pgBossJobId: jobRecord.id, created: false });
    expect(second).toMatchObject({ id: jobRecord.id, pgBossJobId: jobRecord.id, created: false });
    expect(new Set(inserted.flat().map((job) => job.id))).toEqual(new Set([jobRecord.id]));
    expect(new Set(inserted.flat().map((job) => job.singletonKey))).toEqual(new Set([jobRecord.jobKey]));
    expect(inserted.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        startAfter: params.scheduledFor,
        data: expect.objectContaining({ caseId: 'case_01', triggerKey: 'CASE_OPENED:case_01' }),
      }),
    ]));
    expect(inserted.flat().some((job) => job.data.caseId === 'wrong-case')).toBe(false);
    expect(jobRecord).toMatchObject({ status: 'SCHEDULED', pgBossJobId: jobRecord.id });
  });
});
