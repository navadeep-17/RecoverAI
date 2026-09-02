import PgBoss from 'pg-boss';
import { IJobScheduler, ScheduleJobParams } from '@recoverai/core';
import { ScheduledJobRepository } from '@recoverai/db';
import { JobSchedulingError } from '@recoverai/shared';

/** API-side adapter for the same durable ScheduledJob -> pg-boss handoff used by the worker. */
export class ApiPgBossJobScheduler implements IJobScheduler {
  constructor(private readonly boss: PgBoss, private readonly jobs: ScheduledJobRepository) {}
  async schedule(params: ScheduleJobParams): Promise<{ id: string; pgBossJobId?: string; created: boolean }> {
    const { created, job } = await this.jobs.createJob(params.merchantId, { caseId: params.caseId, jobKey: params.jobKey, jobType: params.jobType, scheduledFor: params.scheduledFor, payloadJson: params.payloadJson });
    if (!created && job.status !== 'PENDING_DISPATCH') return { id: job.id, pgBossJobId: job.pgBossJobId || undefined, created: false };
    try {
      const pgBossJobId = job.id;
      await this.boss.insert([{ id: pgBossJobId, name: job.jobType, data: { jobRecordId: job.id, merchantId: job.merchantId, ...(job.payloadJson as Record<string, unknown>) }, startAfter: job.scheduledFor, singletonKey: job.jobKey || job.id }]);
      const acceptedJob = await this.boss.getJobById(pgBossJobId);
      if (!acceptedJob || acceptedJob.id !== pgBossJobId) throw new Error('pg-boss did not confirm the deterministic job identifier');
      await this.jobs.updateJobStatus(params.merchantId, job.id, 'SCHEDULED', pgBossJobId);
      return { id: job.id, pgBossJobId, created };
    } catch (error) {
      throw new JobSchedulingError(job.jobType, error instanceof Error ? error.message : String(error), error);
    }
  }
}
