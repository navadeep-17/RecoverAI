import { describe, expect, it, vi } from 'vitest';
import { ApiPgBossJobScheduler } from '../src/merchant-event-scheduler.js';

describe('API durable scheduler repair', () => {
  it('repairs an existing PENDING_DISPATCH row and confirms the same deterministic queue ID', async () => {
    const job = {
      id: '2082fec6-bb53-45ed-bfb0-a895cb61e3b8',
      merchantId: 'merchant-1',
      caseId: 'case-1',
      jobKey: 'recovery-iteration:case-1:case-opened',
      jobType: 'RECOVERY_ITERATION',
      status: 'PENDING_DISPATCH',
      pgBossJobId: null,
      scheduledFor: new Date('2026-09-02T10:00:00.000Z'),
      payloadJson: { caseId: 'case-1', triggerKey: 'CASE_OPENED:case-1', triggerType: 'CASE_OPENED' },
    };
    const jobs = {
      createJob: vi.fn(async () => ({ created: false, job })),
      updateJobStatus: vi.fn(async () => job),
    };
    const boss = {
      insert: vi.fn(async () => {}),
      getJobById: vi.fn(async (id: string) => ({ id })),
    };
    const scheduler = new ApiPgBossJobScheduler(boss as any, jobs as any);
    const result = await scheduler.schedule({
      merchantId: job.merchantId,
      caseId: job.caseId,
      jobKey: job.jobKey,
      jobType: job.jobType,
      scheduledFor: job.scheduledFor,
      payloadJson: { caseId: job.caseId, triggerKey: 'CASE_OPENED:case-1', triggerType: 'CASE_OPENED' },
    });

    expect(result).toEqual({ id: job.id, pgBossJobId: job.id, created: false });
    expect(boss.insert).toHaveBeenCalledWith([expect.objectContaining({
      id: job.id,
      name: job.jobType,
      singletonKey: job.jobKey,
    })]);
    expect(jobs.updateJobStatus).toHaveBeenCalledWith(job.merchantId, job.id, 'SCHEDULED', job.id);
  });
});
