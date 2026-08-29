import { Prisma, RecoveryOutcome } from '@prisma/client';
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

export class OutcomeRepository {
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
