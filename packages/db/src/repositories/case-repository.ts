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
import {
  validateCaseTransition,
  Money,
  InvalidMoneyError,
  CurrencyMismatchError,
  CaseStateConflictError,
} from '@recoverai/shared';

export type ExactMonetaryInput = string | Prisma.Decimal | Money;

export function toPrismaDecimal(val: ExactMonetaryInput): Prisma.Decimal {
  if (val instanceof Money) {
    return new Prisma.Decimal(val.toDecimalString());
  }

  let str: string;
  if (val instanceof Prisma.Decimal) {
    str = val.toString();
  } else if (typeof val === 'string') {
    str = val;
  } else {
    throw new InvalidMoneyError('Invalid monetary input: must be an exact decimal string, Prisma.Decimal, or Money instance');
  }

  // Canonical validation through domain Money class:
  // - Enforces non-negative (rejects -1.00)
  // - Enforces maximum 2 decimal places (rejects 1.005)
  // - Enforces valid finite decimal representation
  const validatedMoney = Money.fromDecimalString(str);
  return new Prisma.Decimal(validatedMoney.toDecimalString());
}

export interface CreateCaseParams {
  id?: string;
  customerId?: string;
  riskType: RiskType;
  amountAtRisk: ExactMonetaryInput;
  currency?: string;
  incidentKey?: string;
  contextJson: Record<string, unknown>;
  nextEvaluationAt?: Date;
}

export interface ListCasesFilter {
  status?: CaseStatus;
  riskType?: RiskType;
  limit?: number;
  offset?: number;
}

export interface CaseTransitionOptions {
  recoveredAmount?: ExactMonetaryInput;
  resolvedAt?: Date;
  nextEvaluationAt?: Date | null;
}

export class CaseRepository {
  async createCase(merchantId: string, params: CreateCaseParams): Promise<RevenueRiskCase> {
    // If customerId is provided, enforce customer-case tenant consistency
    if (params.customerId) {
      await prisma.customer.findFirstOrThrow({
        where: {
          id: params.customerId,
          merchantId, // Strict tenant ownership
        },
      });
    }

    // Currency consistency check between Money instance and explicit currency param
    let resolvedCurrency = params.currency;
    if (params.amountAtRisk instanceof Money) {
      if (resolvedCurrency && resolvedCurrency.toUpperCase() !== params.amountAtRisk.currency) {
        throw new CurrencyMismatchError(
          `Case currency mismatch: explicit currency "${resolvedCurrency}" does not match Money currency "${params.amountAtRisk.currency}"`,
        );
      }
      resolvedCurrency = params.amountAtRisk.currency;
    } else {
      resolvedCurrency = (resolvedCurrency || 'INR').toUpperCase();
    }

    try {
      return await prisma.revenueRiskCase.create({
        data: {
          id: params.id,
          merchantId,
          customerId: params.customerId,
          riskType: params.riskType,
          amountAtRisk: toPrismaDecimal(params.amountAtRisk),
          currency: resolvedCurrency,
          status: CaseStatus.OPEN,
          incidentKey: params.incidentKey || undefined,
          contextJson: params.contextJson as Prisma.InputJsonValue,
          nextEvaluationAt: params.nextEvaluationAt,
        },
      });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002' &&
        params.incidentKey
      ) {
        return prisma.revenueRiskCase.findUniqueOrThrow({
          where: {
            merchantId_incidentKey: {
              merchantId,
              incidentKey: params.incidentKey,
            },
          },
        });
      }
      throw err;
    }
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

  /**
   * Atomic Compare-And-Set (CAS) case status transition.
   * Validates legal transition from expectedStatus -> nextStatus and updates only if
   * the database row is still in expectedStatus under tenant scope.
   */
  async compareAndSetStatus(
    merchantId: string,
    caseId: string,
    expectedStatus: CaseStatus,
    nextStatus: CaseStatus,
    options?: CaseTransitionOptions,
  ): Promise<RevenueRiskCase> {
    // 1. Enforce canonical domain state-machine transition validator
    validateCaseTransition(expectedStatus, nextStatus, caseId);

    // 2. Authoritative currency validation: when recoveredAmount is Money, lookup authoritative case currency from DB
    if (options?.recoveredAmount instanceof Money) {
      const caseRecord = await prisma.revenueRiskCase.findFirstOrThrow({
        where: { id: caseId, merchantId },
        select: { currency: true },
      });
      if (options.recoveredAmount.currency !== caseRecord.currency) {
        throw new CurrencyMismatchError(
          `Recovered amount currency "${options.recoveredAmount.currency}" does not match case currency "${caseRecord.currency}"`,
        );
      }
    }

    // 3. Perform atomic Compare-And-Set (CAS) update conditioned on expectedStatus
    const updateResult = await prisma.revenueRiskCase.updateMany({
      where: {
        id: caseId,
        merchantId,
        status: expectedStatus, // Atomic CAS invariant
      },
      data: {
        status: nextStatus,
        ...(options?.recoveredAmount !== undefined
          ? { recoveredAmount: toPrismaDecimal(options.recoveredAmount) }
          : {}),
        ...(options?.resolvedAt !== undefined ? { resolvedAt: options.resolvedAt } : {}),
        ...(options?.nextEvaluationAt !== undefined ? { nextEvaluationAt: options.nextEvaluationAt } : {}),
      },
    });

    // 4. If affected row count is 0, a concurrent operation modified the case state
    if (updateResult.count === 0) {
      throw new CaseStateConflictError(
        `Concurrent modification conflict on case ${caseId}: expected status was ${expectedStatus} but row was modified concurrently`,
        caseId,
        expectedStatus,
        nextStatus,
      );
    }

    // 5. Return updated case
    return prisma.revenueRiskCase.findUniqueOrThrow({
      where: { id: caseId },
    });
  }

  async updateCaseStatus(
    merchantId: string,
    caseId: string,
    nextStatus: CaseStatus,
    options?: CaseTransitionOptions,
  ): Promise<RevenueRiskCase> {
    // Assert tenant ownership and load current status
    const currentCase = await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
      select: { status: true },
    });

    return this.compareAndSetStatus(merchantId, caseId, currentCase.status, nextStatus, options);
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
      amountRecovered?: ExactMonetaryInput;
      detailsJson?: Record<string, unknown>;
    },
  ): Promise<RecoveryOutcome> {
    // Assert tenant ownership of parent case and load authoritative case currency
    const parentCase = await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
      select: { currency: true },
    });

    // Enforce currency consistency if amountRecovered is Money
    if (data.amountRecovered instanceof Money) {
      if (data.amountRecovered.currency !== parentCase.currency) {
        throw new CurrencyMismatchError(
          `RecoveryOutcome amountRecovered currency "${data.amountRecovered.currency}" does not match case currency "${parentCase.currency}"`,
        );
      }
    }

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
            ? toPrismaDecimal(data.amountRecovered)
            : null,
        detailsJson: data.detailsJson as Prisma.InputJsonValue,
      },
    });
  }

  async findActiveCaseByIncidentKey(
    merchantId: string,
    incidentKey: string,
  ): Promise<RevenueRiskCase | null> {
    return prisma.revenueRiskCase.findFirst({
      where: {
        merchantId,
        status: {
          in: [CaseStatus.OPEN, CaseStatus.WAITING, CaseStatus.NEEDS_REVIEW],
        },
        OR: [
          { incidentKey },
          {
            contextJson: {
              path: ['incidentKey'],
              equals: incidentKey,
            },
          },
        ],
      },
      include: {
        customer: true,
      },
    });
  }
}
