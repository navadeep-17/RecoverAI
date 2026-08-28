import {
  Prisma,
  RevenueRiskCase,
  RecoveryPlanVersion,
  RecoveryAction,
  RecoveryOutcome,
  CaseStatus,
  RiskType,
  PolicyDecision,
  RecoveryActionType,
  ActionExecutionStatus,
} from '@prisma/client';
import { prisma } from '../client.js';
import { validateCaseTransition } from '@recoverai/shared';

export interface CreateCaseParams {
  id?: string;
  customerId?: string;
  riskType: RiskType;
  amountAtRisk: string | number | Prisma.Decimal;
  currency?: string;
  contextJson: Record<string, unknown>;
  nextEvaluationAt?: Date;
}

export interface ListCasesFilter {
  status?: CaseStatus;
  riskType?: RiskType;
  limit?: number;
  offset?: number;
}

export class CaseRepository {
  async createCase(merchantId: string, params: CreateCaseParams): Promise<RevenueRiskCase> {
    return prisma.revenueRiskCase.create({
      data: {
        id: params.id,
        merchantId,
        customerId: params.customerId,
        riskType: params.riskType,
        amountAtRisk: new Prisma.Decimal(params.amountAtRisk.toString()),
        currency: params.currency || 'INR',
        status: CaseStatus.OPEN,
        contextJson: params.contextJson as Prisma.InputJsonValue,
        nextEvaluationAt: params.nextEvaluationAt,
      },
    });
  }

  async getCaseById(merchantId: string, caseId: string): Promise<RevenueRiskCase | null> {
    return prisma.revenueRiskCase.findFirst({
      where: {
        id: caseId,
        merchantId, // Strict tenant scoping
      },
      include: {
        planVersions: { orderBy: { version: 'desc' } },
        actions: { orderBy: { createdAt: 'desc' } },
        outcomes: { orderBy: { observedAt: 'desc' } },
        customer: true,
      },
    });
  }

  async listCases(merchantId: string, filter: ListCasesFilter = {}): Promise<RevenueRiskCase[]> {
    const { status, riskType, limit = 50, offset = 0 } = filter;
    return prisma.revenueRiskCase.findMany({
      where: {
        merchantId, // Strict tenant scoping
        ...(status ? { status } : {}),
        ...(riskType ? { riskType } : {}),
      },
      orderBy: { openedAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        customer: true,
        actions: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    });
  }

  async updateCaseStatus(
    merchantId: string,
    caseId: string,
    nextStatus: CaseStatus,
    options?: {
      recoveredAmount?: string | number | Prisma.Decimal;
      resolvedAt?: Date;
      nextEvaluationAt?: Date | null;
    },
  ): Promise<RevenueRiskCase> {
    // Assert tenant ownership and fetch current status
    const currentCase = await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    // Enforce canonical domain state-machine transition validator
    validateCaseTransition(currentCase.status, nextStatus, caseId);

    return prisma.revenueRiskCase.update({
      where: { id: caseId },
      data: {
        status: nextStatus,
        ...(options?.recoveredAmount !== undefined
          ? { recoveredAmount: new Prisma.Decimal(options.recoveredAmount.toString()) }
          : {}),
        ...(options?.resolvedAt !== undefined ? { resolvedAt: options.resolvedAt } : {}),
        ...(options?.nextEvaluationAt !== undefined ? { nextEvaluationAt: options.nextEvaluationAt } : {}),
      },
    });
  }

  async addPlanVersion(
    merchantId: string,
    caseId: string,
    data: {
      version: number;
      diagnosisCode: string;
      diagnosisSummary: string;
      confidence: number;
      proposedActionType: RecoveryActionType;
      proposedActionParams: Record<string, unknown>;
      reasoningSummary: string;
      followUpAfterSeconds?: number;
      shouldStop?: boolean;
      shouldEscalate?: boolean;
    },
  ): Promise<RecoveryPlanVersion> {
    // Assert tenant ownership of parent case
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    return prisma.recoveryPlanVersion.create({
      data: {
        caseId,
        version: data.version,
        diagnosisCode: data.diagnosisCode,
        diagnosisSummary: data.diagnosisSummary,
        confidence: data.confidence,
        proposedActionType: data.proposedActionType,
        proposedActionParams: data.proposedActionParams as Prisma.InputJsonValue,
        reasoningSummary: data.reasoningSummary,
        followUpAfterSeconds: data.followUpAfterSeconds,
        shouldStop: data.shouldStop ?? false,
        shouldEscalate: data.shouldEscalate ?? false,
      },
    });
  }

  async recordAction(
    merchantId: string,
    caseId: string,
    data: {
      planVersionId?: string;
      actionType: RecoveryActionType;
      actionParams: Record<string, unknown>;
      idempotencyKey: string;
      policyDecision: PolicyDecision;
      policyRationale: string;
      status?: ActionExecutionStatus;
      providerName?: string;
      externalActionId?: string;
      executionMetadata?: Record<string, unknown>;
    },
  ): Promise<RecoveryAction> {
    // Assert tenant ownership of parent case
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    if (data.planVersionId) {
      await prisma.recoveryPlanVersion.findFirstOrThrow({
        where: { id: data.planVersionId, caseId },
      });
    }

    return prisma.recoveryAction.create({
      data: {
        caseId,
        planVersionId: data.planVersionId,
        actionType: data.actionType,
        actionParams: data.actionParams as Prisma.InputJsonValue,
        idempotencyKey: data.idempotencyKey,
        policyDecision: data.policyDecision,
        policyRationale: data.policyRationale,
        status: data.status || ActionExecutionStatus.PENDING,
        providerName: data.providerName,
        externalActionId: data.externalActionId,
        executionMetadata: data.executionMetadata as Prisma.InputJsonValue,
      },
    });
  }

  async recordOutcome(
    merchantId: string,
    caseId: string,
    data: {
      actionId?: string;
      merchantEventId?: string;
      outcomeType: string;
      amountRecovered?: string | number | Prisma.Decimal;
      detailsJson?: Record<string, unknown>;
    },
  ): Promise<RecoveryOutcome> {
    // Assert tenant ownership of parent case
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    if (data.actionId) {
      await prisma.recoveryAction.findFirstOrThrow({
        where: { id: data.actionId, caseId },
      });
    }

    if (data.merchantEventId) {
      await prisma.merchantEvent.findFirstOrThrow({
        where: { id: data.merchantEventId, merchantId },
      });
    }

    return prisma.recoveryOutcome.create({
      data: {
        caseId,
        actionId: data.actionId,
        merchantEventId: data.merchantEventId,
        outcomeType: data.outcomeType,
        amountRecovered:
          data.amountRecovered !== undefined
            ? new Prisma.Decimal(data.amountRecovered.toString())
            : null,
        detailsJson: data.detailsJson as Prisma.InputJsonValue,
      },
    });
  }
}
