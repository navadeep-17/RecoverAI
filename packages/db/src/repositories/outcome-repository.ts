import { ActionExecutionStatus, CaseStatus, Prisma, RecoveryActionType, RecoveryOutcome } from '@prisma/client';
import { prisma } from '../client.js';
import { Money, CurrencyMismatchError } from '@recoverai/shared';
import { ExactMonetaryInput, toPrismaDecimal } from './case-repository.js';

export interface RecordOutcomeParams {
  actionId?: string;
  merchantEventId?: string;
  dedupeKey?: string;
  outcomeType: string;
  amountRecovered?: ExactMonetaryInput;
  detailsJson?: Record<string, unknown>;
  observedAt?: Date;
}

export interface RecordOutcomeResult {
  outcome: RecoveryOutcome;
  created: boolean;
}

export interface MonetaryRecoveryClaimResult {
  wonRecovery: boolean;
  deduplicated: boolean;
  outcome: RecoveryOutcome | null;
  caseStatus: CaseStatus;
}

export class OutcomeRepository {
  /**
   * Atomically binds the only credit-bearing monetary outcome to a case.
   * A losing concurrent candidate is rolled back with its transaction, so it
   * cannot later be mistaken for attributed recovered revenue.
   */
  async claimMonetaryRecovery(
    merchantId: string,
    caseId: string,
    params: RecordOutcomeParams,
  ): Promise<MonetaryRecoveryClaimResult> {
    try {
      return await prisma.$transaction(async (tx) => {
        // Lock the parent before inserting an outcome. A child FK insert takes a
        // parent relationship lock, so taking the exclusive parent row lock first
        // gives every contender one deterministic lock order and prevents a cycle.
        const [parentCase] = await tx.$queryRaw<Array<{
          id: string;
          currency: string;
          status: CaseStatus;
          recoveryOutcomeId: string | null;
          amountAtRisk: Prisma.Decimal;
        }>>(Prisma.sql`
          SELECT "id", "currency", "status", "recoveryOutcomeId", "amountAtRisk"
          FROM "revenue_risk_cases"
          WHERE "id" = ${caseId} AND "merchantId" = ${merchantId}
          FOR UPDATE
        `);
        if (!parentCase) {
          throw new Error(`RevenueRiskCase not found for merchant: ${caseId}`);
        }
        if (parentCase.recoveryOutcomeId || parentCase.status === CaseStatus.RECOVERED) {
          const winner = parentCase.recoveryOutcomeId
            ? await tx.recoveryOutcome.findUnique({ where: { id: parentCase.recoveryOutcomeId } })
            : null;
          return { wonRecovery: false, deduplicated: !!winner && winner.dedupeKey === params.dedupeKey, outcome: winner, caseStatus: parentCase.status };
        }
        if (parentCase.status === CaseStatus.STOPPED || parentCase.status === CaseStatus.EXHAUSTED) {
          throw new Error(`Cannot claim recovery for terminal case status: ${parentCase.status}`);
        }
        if (![CaseStatus.OPEN, CaseStatus.WAITING, CaseStatus.NEEDS_REVIEW].includes(parentCase.status)) {
          throw new Error(`Cannot claim recovery for non-recoverable case status: ${parentCase.status}`);
        }
        if (params.amountRecovered === undefined) {
          throw new Error('Cannot claim monetary recovery without an exact recovered amount');
        }
        if (params.amountRecovered instanceof Money && params.amountRecovered.currency !== parentCase.currency) {
          throw new CurrencyMismatchError(
            `RecoveryOutcome amountRecovered currency "${params.amountRecovered.currency}" does not match case currency "${parentCase.currency}"`,
          );
        }
        const exactRecoveredAmount = toPrismaDecimal(params.amountRecovered);
        if (!exactRecoveredAmount.greaterThan(0) || !exactRecoveredAmount.equals(parentCase.amountAtRisk)) {
          throw new Error('Monetary recovery must exactly and positively settle the authoritative case amount');
        }
        if (params.actionId) {
          await tx.recoveryAction.findFirstOrThrow({
            where: {
              id: params.actionId,
              caseId,
              status: ActionExecutionStatus.SUCCESS,
              actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
            },
          });
        }
        if (params.merchantEventId) {
          await tx.merchantEvent.findFirstOrThrow({ where: { id: params.merchantEventId, merchantId } });
        }

        const candidate = await tx.recoveryOutcome.create({
          data: {
            caseId,
            actionId: params.actionId,
            merchantEventId: params.merchantEventId,
            dedupeKey: params.dedupeKey,
            outcomeType: params.outcomeType,
            amountRecovered: exactRecoveredAmount,
            detailsJson: params.detailsJson as Prisma.InputJsonValue,
            observedAt: params.observedAt || new Date(),
          },
        });
        await tx.revenueRiskCase.update({
          where: { id: caseId },
          data: {
            status: CaseStatus.RECOVERED,
            recoveredAmount: exactRecoveredAmount,
            resolvedAt: params.observedAt || new Date(),
            recoveryOutcomeId: candidate.id,
          },
        });
        return { wonRecovery: true, deduplicated: false, outcome: candidate, caseStatus: CaseStatus.RECOVERED };
      });
    } catch (error) {
      const existing = await prisma.revenueRiskCase.findFirstOrThrow({
        where: { id: caseId, merchantId },
        select: { status: true, recoveryOutcomeId: true },
      });
      if (existing.recoveryOutcomeId || existing.status === CaseStatus.RECOVERED) {
        const winner = existing.recoveryOutcomeId
          ? await prisma.recoveryOutcome.findUnique({ where: { id: existing.recoveryOutcomeId } })
          : null;
        return { wonRecovery: false, deduplicated: !!winner && winner.dedupeKey === params.dedupeKey, outcome: winner, caseStatus: existing.status };
      }
      throw error;
    }
  }

  /**
   * Records an authoritative RecoveryOutcome under a tenant-scoped case with atomic create-or-get semantics.
   *
   * Invariants:
   * - Enforces parent case belongs to merchantId.
   * - If amountRecovered is Money, verifies exact currency matches case currency.
   * - Atomic insert: if P2002 unique constraint is violated (e.g. duplicate dedupeKey), re-reads existing and returns created: false.
   * - Validates actionId and merchantEventId foreign keys when provided.
   */
  async recordOutcome(
    merchantId: string,
    caseId: string,
    params: RecordOutcomeParams,
  ): Promise<RecordOutcomeResult> {
    // Assert tenant ownership of parent case and load authoritative case currency
    const parentCase = await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
      select: { currency: true },
    });

    // Enforce currency consistency if amountRecovered is Money
    if (params.amountRecovered instanceof Money) {
      if (params.amountRecovered.currency !== parentCase.currency) {
        throw new CurrencyMismatchError(
          `RecoveryOutcome amountRecovered currency "${params.amountRecovered.currency}" does not match case currency "${parentCase.currency}"`,
        );
      }
    }

    if (params.actionId) {
      await prisma.recoveryAction.findFirstOrThrow({
        where: { id: params.actionId, caseId },
      });
    }

    if (params.merchantEventId) {
      await prisma.merchantEvent.findFirstOrThrow({
        where: { id: params.merchantEventId, merchantId },
      });
    }

    try {
      const outcome = await prisma.recoveryOutcome.create({
        data: {
          caseId,
          actionId: params.actionId,
          merchantEventId: params.merchantEventId,
          dedupeKey: params.dedupeKey,
          outcomeType: params.outcomeType,
          amountRecovered:
            params.amountRecovered !== undefined
              ? toPrismaDecimal(params.amountRecovered)
              : null,
          detailsJson: params.detailsJson as Prisma.InputJsonValue,
          observedAt: params.observedAt || new Date(),
        },
      });
      return { outcome, created: true };
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        // Unique constraint violation (e.g. [caseId, dedupeKey]) -> atomic re-read
        let existing: RecoveryOutcome | null = null;
        if (params.dedupeKey) {
          existing = await prisma.recoveryOutcome.findFirst({
            where: { caseId, dedupeKey: params.dedupeKey },
          });
        }
        if (!existing && params.merchantEventId) {
          existing = await prisma.recoveryOutcome.findFirst({
            where: { caseId, merchantEventId: params.merchantEventId },
          });
        }
        if (existing) {
          return { outcome: existing, created: false };
        }
      }
      throw err;
    }
  }

  /**
   * Finds an outcome for a specific merchant event in a case (for idempotency deduplication).
   */
  async findOutcomeByEvent(
    merchantId: string,
    caseId: string,
    merchantEventId: string,
  ): Promise<RecoveryOutcome | null> {
    // Verify tenant ownership
    const parentCase = await prisma.revenueRiskCase.findFirst({
      where: { id: caseId, merchantId },
    });
    if (!parentCase) return null;

    return prisma.recoveryOutcome.findFirst({
      where: {
        caseId,
        merchantEventId,
      },
    });
  }

  /**
   * Finds an outcome matching a custom dedupeKey in detailsJson.
   */
  async findOutcomeByDedupeKey(
    merchantId: string,
    caseId: string,
    dedupeKey: string,
  ): Promise<RecoveryOutcome | null> {
    const parentCase = await prisma.revenueRiskCase.findFirst({
      where: { id: caseId, merchantId },
    });
    if (!parentCase) return null;

    return prisma.recoveryOutcome.findFirst({
      where: {
        caseId,
        OR: [
          { dedupeKey },
          {
            detailsJson: {
              path: ['dedupeKey'],
              equals: dedupeKey,
            },
          },
        ],
      },
    });
  }

  /**
   * Lists all outcomes for a case ordered by observedAt descending.
   */
  async listOutcomesByCase(
    merchantId: string,
    caseId: string,
  ): Promise<RecoveryOutcome[]> {
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    return prisma.recoveryOutcome.findMany({
      where: { caseId },
      orderBy: { observedAt: 'desc' },
    });
  }
}
