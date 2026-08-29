import { Prisma, RecoveryIterationTrigger } from '@prisma/client';
import { prisma } from '../client.js';

export interface ClaimTriggerResult {
  claimed: boolean;
  trigger: RecoveryIterationTrigger;
}

export class TriggerRepository {
  /**
   * Atomically claims an orchestration iteration trigger for a given (merchantId, caseId, triggerKey).
   *
   * Invariants:
   * - Strict tenant ownership (caseId belongs to merchantId).
   * - Atomic: Uses unique index [merchantId, caseId, triggerKey].
   * - If already claimed (P2002 error), re-reads the existing trigger and returns claimed: false.
   * - Winner returns claimed: true.
   */
  async claimTrigger(
    merchantId: string,
    caseId: string,
    triggerKey: string,
    triggerType: string,
  ): Promise<ClaimTriggerResult> {
    // Assert tenant ownership of parent case
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    try {
      const trigger = await prisma.recoveryIterationTrigger.create({
        data: {
          merchantId,
          caseId,
          triggerKey,
          triggerType,
          status: 'CLAIMED',
        },
      });
      return { claimed: true, trigger };
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        const existing = await prisma.recoveryIterationTrigger.findUniqueOrThrow({
          where: {
            merchantId_caseId_triggerKey: {
              merchantId,
              caseId,
              triggerKey,
            },
          },
        });
        return { claimed: false, trigger: existing };
      }
      throw err;
    }
  }

  /**
   * Marks a claimed trigger as COMPLETED or FAILED, saving the result JSON.
   */
  async completeTrigger(
    merchantId: string,
    caseId: string,
    triggerId: string,
    status: 'COMPLETED' | 'FAILED',
    resultJson?: Record<string, unknown>,
  ): Promise<RecoveryIterationTrigger> {
    return prisma.recoveryIterationTrigger.update({
      where: {
        id: triggerId,
        merchantId,
        caseId,
      },
      data: {
        status,
        resultJson: resultJson as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
  }

  /**
   * Retrieves a trigger by key.
   */
  async findTrigger(
    merchantId: string,
    caseId: string,
    triggerKey: string,
  ): Promise<RecoveryIterationTrigger | null> {
    return prisma.recoveryIterationTrigger.findUnique({
      where: {
        merchantId_caseId_triggerKey: {
          merchantId,
          caseId,
          triggerKey,
        },
      },
    });
  }
}
