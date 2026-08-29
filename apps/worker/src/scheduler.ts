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

    // If another concurrent caller already created this ScheduledJob, return the existing authoritative job
    if (!created) {
      return {
        id: jobRecord.id,
        pgBossJobId: jobRecord.pgBossJobId || undefined,
        created: false,
      };
    }

    // 2. Schedule with pg-boss using startAfter delay
    const now = Date.now();
    const diffSeconds = Math.max(0, Math.floor((params.scheduledFor.getTime() - now) / 1000));

    let pgBossJobId: string | null = null;
    try {
      pgBossJobId = await this.boss.send(
        params.jobType,
        {
          jobRecordId: jobRecord.id,
          merchantId: params.merchantId,
          ...params.payloadJson,
        },
        {
          startAfter: diffSeconds,
          singletonKey: params.jobKey || undefined,
        },
      );

      if (!pgBossJobId) {
        throw new Error('pg-boss returned empty job identifier');
      }

      // 3. Mark SCHEDULED only after pg-boss has accepted the job with authoritative pgBossJobId
      await this.scheduledJobRepo.updateJobStatus(
        params.merchantId,
        jobRecord.id,
        'SCHEDULED',
        pgBossJobId,
      );

      return { id: jobRecord.id, pgBossJobId, created: true };
    } catch (err: unknown) {
      // 4. On failure, mark DB record as FAILED and fail closed
      await this.scheduledJobRepo.updateJobStatus(
        params.merchantId,
        jobRecord.id,
        'FAILED',
      );

      const errMsg = err instanceof Error ? err.message : String(err);
      throw new JobSchedulingError(params.jobType, errMsg, err);
    }
  }
}
