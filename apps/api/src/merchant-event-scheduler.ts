import PgBoss from 'pg-boss';
import { IJobScheduler, ScheduleJobParams } from '@recoverai/core';
import { ScheduledJobRepository } from '@recoverai/db';
import { JobSchedulingError } from '@recoverai/shared';

/** API-side adapter for the same durable ScheduledJob -> pg-boss handoff used by the worker. */
export class ApiPgBossJobScheduler implements IJobScheduler {
  constructor(private readonly boss: PgBoss, private readonly jobs: ScheduledJobRepository) {}
  async schedule(params: ScheduleJobParams): Promise<{ id: string; pgBossJobId?: string; created: boolean }> {
    const { created, job } = await this.jobs.createJob(params.merchantId, { caseId: params.caseId, jobKey: params.jobKey, jobType: params.jobType, scheduledFor: params.scheduledFor, payloadJson: params.payloadJson });
    if (!created) return { id: job.id, pgBossJobId: job.pgBossJobId || undefined, created: false };
    try {
      const pgBossJobId = await this.boss.send(params.jobType, { jobRecordId: job.id, merchantId: params.merchantId, ...params.payloadJson }, { startAfter: Math.max(0, Math.floor((params.scheduledFor.getTime() - Date.now()) / 1000)), singletonKey: params.jobKey || undefined });
      if (!pgBossJobId) throw new Error('pg-boss returned empty job identifier');
      await this.jobs.updateJobStatus(params.merchantId, job.id, 'SCHEDULED', pgBossJobId);
      return { id: job.id, pgBossJobId, created: true };
    } catch (error) {
      await this.jobs.updateJobStatus(params.merchantId, job.id, 'FAILED');
      throw new JobSchedulingError(params.jobType, error instanceof Error ? error.message : String(error), error);
    }
  }
}
