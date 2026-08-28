import { Prisma, AuditEvent, AuditActorType } from '@prisma/client';
import { prisma } from '../client.js';

export class AuditRepository {
  async record(
    merchantId: string,
    data: {
      caseId?: string;
      eventType: string;
      actorType: AuditActorType;
      actorId?: string;
      inputSummaryJson?: Record<string, unknown>;
      outputSummaryJson?: Record<string, unknown>;
      reasonCode?: string;
    },
  ): Promise<AuditEvent> {
    return prisma.auditEvent.create({
      data: {
        merchantId,
        caseId: data.caseId,
        eventType: data.eventType,
        actorType: data.actorType,
        actorId: data.actorId,
        inputSummaryJson: data.inputSummaryJson as Prisma.InputJsonValue,
        outputSummaryJson: data.outputSummaryJson as Prisma.InputJsonValue,
        reasonCode: data.reasonCode,
      },
    });
  }

  async listByCase(merchantId: string, caseId: string): Promise<AuditEvent[]> {
    return prisma.auditEvent.findMany({
      where: {
        merchantId,
        caseId,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listByMerchant(merchantId: string, limit = 100): Promise<AuditEvent[]> {
    return prisma.auditEvent.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
