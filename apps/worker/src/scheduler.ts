import PgBoss from 'pg-boss';
import { IJobScheduler, ScheduleJobParams } from '@recoverai/core';
import { ScheduledJobRepository } from '@recoverai/db';
import { JobSchedulingError } from '@recoverai/shared';

export class PgBossJobScheduler implements IJobScheduler {
  constructor(
    private boss: PgBoss,
    private scheduledJobRepo: ScheduledJobRepository,
  ) {}

  async schedule(params: ScheduleJobParams): Promise<{ id: string; pgBossJobId: string }> {
    // 1. Persist ScheduledJob row in PostgreSQL with initial PENDING_DISPATCH status
    const jobRecord = await this.scheduledJobRepo.createJob(params.merchantId, {
      caseId: params.caseId,
      jobType: params.jobType,
      scheduledFor: params.scheduledFor,
      payloadJson: params.payloadJson,
    });

    // Explicitly record initial status PENDING_DISPATCH
    await this.scheduledJobRepo.updateJobStatus(
      params.merchantId,
      jobRecord.id,
      'PENDING_DISPATCH',
    );

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

      return { id: jobRecord.id, pgBossJobId };
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
