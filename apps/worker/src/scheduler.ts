import PgBoss from 'pg-boss';
import { IJobScheduler, ScheduleJobParams } from '@recoverai/core';
import { ScheduledJobRepository } from '@recoverai/db';
import { JobSchedulingError } from '@recoverai/shared';

export class PgBossJobScheduler implements IJobScheduler {
  constructor(
    private boss: PgBoss,
    private scheduledJobRepo: ScheduledJobRepository,
  ) {}

  async schedule(params: ScheduleJobParams): Promise<{ id: string; pgBossJobId?: string; created: boolean }> {
    // 1. Persist ScheduledJob row in PostgreSQL idempotently
    const { created, job: jobRecord } = await this.scheduledJobRepo.createJob(params.merchantId, {
      caseId: params.caseId,
      jobKey: params.jobKey,
      jobType: params.jobType,
      scheduledFor: params.scheduledFor,
      payloadJson: params.payloadJson,
    });

    // A completed handoff is authoritative and needs no repair.
    if (!created && jobRecord.status !== 'PENDING_DISPATCH') {
      return {
        id: jobRecord.id,
        pgBossJobId: jobRecord.pgBossJobId || undefined,
        created: false,
      };
    }

    // Use the ScheduledJob UUID as the pg-boss UUID. Retrying an interrupted
    // PENDING_DISPATCH handoff therefore converges on the same queue record,
    // including when two processes repair it concurrently.
    const pgBossJobId = jobRecord.id;
    try {
      await this.boss.insert([{
        id: pgBossJobId,
        name: jobRecord.jobType,
        data: {
          jobRecordId: jobRecord.id,
          merchantId: jobRecord.merchantId,
          ...(jobRecord.payloadJson as Record<string, unknown>),
        },
        startAfter: jobRecord.scheduledFor,
        singletonKey: jobRecord.jobKey || jobRecord.id,
      }]);

      const acceptedJob = await this.boss.getJobById(pgBossJobId);
      if (!acceptedJob || acceptedJob.id !== pgBossJobId) throw new Error('pg-boss did not confirm the deterministic job identifier');

      // 3. Mark SCHEDULED only after pg-boss has accepted the job with authoritative pgBossJobId
      await this.scheduledJobRepo.updateJobStatus(
        params.merchantId,
        jobRecord.id,
        'SCHEDULED',
        pgBossJobId,
      );

      return { id: jobRecord.id, pgBossJobId, created };
    } catch (err: unknown) {
      // Keep the authoritative row repairable. Dispatch errors can be
      // ambiguous, so FAILED would incorrectly make a later safe repair skip it.
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new JobSchedulingError(jobRecord.jobType, errMsg, err);
    }
  }
}
