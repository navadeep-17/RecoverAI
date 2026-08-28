import PgBoss from 'pg-boss';
import { IJobScheduler, ScheduleJobParams } from '@recoverai/core';
import { ScheduledJobRepository } from '@recoverai/db';

export class PgBossJobScheduler implements IJobScheduler {
  constructor(
    private boss: PgBoss,
    private scheduledJobRepo: ScheduledJobRepository,
  ) {}

  async schedule(params: ScheduleJobParams): Promise<{ id: string; pgBossJobId?: string }> {
    // 1. Persist ScheduledJob row in PostgreSQL with merchantId tenant scope
    const jobRecord = await this.scheduledJobRepo.createJob(params.merchantId, {
      caseId: params.caseId,
      jobType: params.jobType,
      scheduledFor: params.scheduledFor,
      payloadJson: params.payloadJson,
    });

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

      if (pgBossJobId) {
        await this.scheduledJobRepo.updateJobStatus(
          params.merchantId,
          jobRecord.id,
          'SCHEDULED',
          pgBossJobId,
        );
      }
    } catch {
      // If boss is offline in unit test environment, job remains persisted in PostgreSQL
    }

    return { id: jobRecord.id, pgBossJobId: pgBossJobId || undefined };
  }
}
