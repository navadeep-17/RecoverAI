import { Prisma, ScheduledJob } from '@prisma/client';
import { prisma } from '../client.js';

export interface CreateScheduledJobParams {
  caseId?: string;
  jobType: string;
  scheduledFor: Date;
  payloadJson: Record<string, unknown>;
  pgBossJobId?: string;
}

export class ScheduledJobRepository {
  async createJob(
    merchantId: string,
    params: CreateScheduledJobParams,
  ): Promise<ScheduledJob> {
    return prisma.scheduledJob.create({
      data: {
        merchantId,
        caseId: params.caseId,
        jobType: params.jobType,
        pgBossJobId: params.pgBossJobId,
        scheduledFor: params.scheduledFor,
        status: 'PENDING_DISPATCH',
        payloadJson: params.payloadJson as Prisma.InputJsonValue,
      },
    });
  }

  async getJobById(merchantId: string, jobId: string): Promise<ScheduledJob | null> {
    return prisma.scheduledJob.findFirst({
      where: {
        id: jobId,
        merchantId,
      },
    });
  }

  async listJobsByCase(merchantId: string, caseId: string): Promise<ScheduledJob[]> {
    return prisma.scheduledJob.findMany({
      where: {
        merchantId,
        caseId,
      },
      orderBy: { scheduledFor: 'asc' },
    });
  }

  async listScheduledJobs(merchantId: string, status = 'SCHEDULED'): Promise<ScheduledJob[]> {
    return prisma.scheduledJob.findMany({
      where: {
        merchantId,
        status,
      },
      orderBy: { scheduledFor: 'asc' },
    });
  }

  async updateJobStatus(
    merchantId: string,
    jobId: string,
    status: string,
    pgBossJobId?: string,
  ): Promise<ScheduledJob> {
    const job = await prisma.scheduledJob.findFirstOrThrow({
      where: { id: jobId, merchantId },
    });

    return prisma.scheduledJob.update({
      where: { id: job.id },
      data: {
        status,
        ...(pgBossJobId ? { pgBossJobId } : {}),
      },
    });
  }
}
