import { Prisma, RecoveryIterationTrigger } from '@prisma/client';
import { prisma } from '../client.js';

export interface ClaimTriggerResult {
  claimed: boolean;
  trigger: RecoveryIterationTrigger;
}

export interface ClaimTriggerOptions {
  leaseDurationMs?: number;
  maxAttempts?: number;
  now?: Date;
}

export interface CompleteTriggerResult {
  completed: boolean;
  trigger?: RecoveryIterationTrigger | null;
}

export class TriggerRepository {
  /**
   * Atomically claims or reclaims an orchestration iteration trigger for a given (merchantId, caseId, triggerKey).
   *
   * Invariants & Rules:
   * - Strict tenant ownership (caseId belongs to merchantId).
   * - Initial Claim: Uses unique constraint [merchantId, caseId, triggerKey].
   * - COMPLETED: Duplicate event -> NEVER rerun -> returns claimed: false.
   * - CLAIMED with unexpired lease: Owned by another worker -> returns claimed: false.
   * - CLAIMED with expired lease: Atomically reclaimed via DB CAS (updateMany with leaseExpiresAt <= now) -> increment attemptCount -> returns claimed: true.
   * - FAILED with attemptCount < maxAttempts: Atomically reclaimed via DB CAS (updateMany with status = 'FAILED') -> increment attemptCount -> returns claimed: true.
   * - Concurrent Reclaim: Exactly one worker wins the DB CAS update; other workers return claimed: false.
   * - No in-memory locks.
   */
  async claimTrigger(
    merchantId: string,
    caseId: string,
    triggerKey: string,
    triggerType: string,
    options?: ClaimTriggerOptions,
  ): Promise<ClaimTriggerResult> {
    // Assert tenant ownership of parent case
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    const now = options?.now || new Date();
    const leaseDurationMs = options?.leaseDurationMs ?? 300_000; // 5 minutes default
    const maxAttempts = options?.maxAttempts ?? 3;
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    try {
      const trigger = await prisma.recoveryIterationTrigger.create({
        data: {
          merchantId,
          caseId,
          triggerKey,
          triggerType,
          status: 'CLAIMED',
          attemptCount: 1,
          claimedAt: now,
          leaseExpiresAt,
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

        // 1. COMPLETED: duplicate event, never rerun
        if (existing.status === 'COMPLETED') {
          return { claimed: false, trigger: existing };
        }

        // 2. CLAIMED with unexpired lease: another active worker owns it
        if (existing.status === 'CLAIMED' && existing.leaseExpiresAt.getTime() > now.getTime()) {
          return { claimed: false, trigger: existing };
        }

        // 3. CLAIMED with expired lease OR FAILED with attemptCount < maxAttempts
        const isExpiredClaim = existing.status === 'CLAIMED' && existing.leaseExpiresAt.getTime() <= now.getTime();
        const isRetryableFailure = existing.status === 'FAILED' && existing.attemptCount < maxAttempts;

        if (isExpiredClaim || isRetryableFailure) {
          // Atomic database CAS reclaim
          const updateResult = await prisma.recoveryIterationTrigger.updateMany({
            where: {
              id: existing.id,
              merchantId,
              caseId,
              status: existing.status,
              ...(existing.status === 'CLAIMED' ? { leaseExpiresAt: { lte: now } } : {}),
            },
            data: {
              status: 'CLAIMED',
              attemptCount: { increment: 1 },
              claimedAt: now,
              leaseExpiresAt,
            },
          });

          if (updateResult.count > 0) {
            const reloaded = await prisma.recoveryIterationTrigger.findUniqueOrThrow({
              where: { id: existing.id },
            });
            return { claimed: true, trigger: reloaded };
          }
        }

        // CAS lost or not reclaimable: return current state
        const fresh = await prisma.recoveryIterationTrigger.findUniqueOrThrow({
          where: { id: existing.id },
        });
        return { claimed: false, trigger: fresh };
      }
      throw err;
    }
  }

  /**
   * Marks a claimed trigger as COMPLETED or FAILED with lease fencing.
   * Requires expectedAttemptCount (fencing token) to match the claimed lease generation.
   * If the trigger was reclaimed by another worker while this worker was running (attemptCount incremented),
   * the update returns completed: false without overwriting the newer worker's claim.
   */
  async completeTrigger(
    merchantId: string,
    caseId: string,
    triggerId: string,
    status: 'COMPLETED' | 'FAILED',
    resultJson: Record<string, unknown> | undefined,
    expectedAttemptCount: number,
  ): Promise<CompleteTriggerResult> {
    const updateResult = await prisma.recoveryIterationTrigger.updateMany({
      where: {
        id: triggerId,
        merchantId,
        caseId,
        status: 'CLAIMED',
        attemptCount: expectedAttemptCount,
      },
      data: {
        status,
        resultJson: resultJson as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });

    if (updateResult.count === 0) {
      // Stale worker lost ownership (e.g. lease expired and reclaimed by another worker)
      const current = await prisma.recoveryIterationTrigger.findFirst({
        where: { id: triggerId, merchantId, caseId },
      });
      return { completed: false, trigger: current };
    }

    const updated = await prisma.recoveryIterationTrigger.findUniqueOrThrow({
      where: { id: triggerId },
    });
    return { completed: true, trigger: updated };
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
