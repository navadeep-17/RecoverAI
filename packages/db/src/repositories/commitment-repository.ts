import { Prisma, RecoveryCommitment } from '@prisma/client';
import { prisma } from '../client.js';

export interface CreateCommitmentParams {
  /**
   * Optional source message ID for message-idempotent deduplication.
   */
  sourceMessageId?: string | null;
  /**
   * The promised amount. Must be a valid non-negative decimal string (e.g. "1500.00").
   */
  promisedAmount: string;
  /**
   * The promised date by which the customer will pay.
   */
  promisedDate: Date;
  /**
   * Optional free-text extracted from conversation or context.
   */
  extractedFromText?: string | null;
  /**
   * Initial status (defaults to 'PENDING').
   */
  status?: string;
}

export interface CreateCommitmentResult {
  commitment: RecoveryCommitment;
  created: boolean;
}

/**
 * Repository for RecoveryCommitment: authoritative promise-to-pay persistence.
 *
 * RecoveryCommitment is the system-of-record for a customer's structured
 * commitment to repay an overdue amount by a specific date.
 *
 * RecoveryAction.executionMetadata is supplemental evidence only.
 */
export class CommitmentRepository {
  /**
   * Persists an authoritative RecoveryCommitment idempotently under a tenant-scoped case.
   *
   * Verifies that the case belongs to the merchantId before creating.
   * On unique constraint violation on [caseId, sourceMessageId], re-reads existing commitment.
   */
  async createCommitmentIdempotently(
    merchantId: string,
    caseId: string,
    params: CreateCommitmentParams,
  ): Promise<CreateCommitmentResult> {
    // Assert tenant ownership of the parent case
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    try {
      const commitment = await prisma.recoveryCommitment.create({
        data: {
          caseId,
          sourceMessageId: params.sourceMessageId ?? null,
          promisedAmount: new Prisma.Decimal(params.promisedAmount),
          promisedDate: params.promisedDate,
          extractedFromText: params.extractedFromText ?? null,
          status: params.status || 'PENDING',
        },
      });
      return { commitment, created: true };
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        params.sourceMessageId
      ) {
        // Unique constraint violation on [caseId, sourceMessageId]
        const existing = await prisma.recoveryCommitment.findFirstOrThrow({
          where: { caseId, sourceMessageId: params.sourceMessageId },
        });
        return { commitment: existing, created: false };
      }
      throw error;
    }
  }

  /**
   * Persists an authoritative RecoveryCommitment under a tenant-scoped case.
   *
   * Verifies that the case belongs to the merchantId before creating.
   */
  async createCommitment(
    merchantId: string,
    caseId: string,
    params: CreateCommitmentParams,
  ): Promise<RecoveryCommitment> {
    const result = await this.createCommitmentIdempotently(merchantId, caseId, params);
    return result.commitment;
  }

  /**
   * Finds a commitment by sourceMessageId scoped to tenant and case.
   */
  async findBySourceMessageId(
    merchantId: string,
    caseId: string,
    sourceMessageId: string,
  ): Promise<RecoveryCommitment | null> {
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    return prisma.recoveryCommitment.findFirst({
      where: { caseId, sourceMessageId },
    });
  }

  /**
   * Returns all active (non-cancelled) commitments for a case.
   */
  async getActiveCommitmentsForCase(
    merchantId: string,
    caseId: string,
  ): Promise<RecoveryCommitment[]> {
    // Verify tenant ownership
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    return prisma.recoveryCommitment.findMany({
      where: {
        caseId,
        status: { not: 'CANCELLED' },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Cancels a commitment (CAS: only if currently PENDING).
   */
  async cancelCommitment(
    merchantId: string,
    caseId: string,
    commitmentId: string,
  ): Promise<RecoveryCommitment | null> {
    // Verify tenant ownership
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    const result = await prisma.recoveryCommitment.updateMany({
      where: {
        id: commitmentId,
        caseId,
        status: 'PENDING',
      },
      data: { status: 'CANCELLED' },
    });

    if (result.count === 0) {
      return null;
    }

    return prisma.recoveryCommitment.findUnique({ where: { id: commitmentId } });
  }

  /**
   * Updates commitment status (e.g. FULFILLED, BROKEN) scoped to tenant and case.
   */
  async updateCommitmentStatus(
    merchantId: string,
    caseId: string,
    commitmentId: string,
    status: 'PENDING' | 'FULFILLED' | 'BROKEN' | 'CANCELLED',
  ): Promise<RecoveryCommitment> {
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    const commitment = await prisma.recoveryCommitment.findFirstOrThrow({
      where: { id: commitmentId, caseId },
    });

    return prisma.recoveryCommitment.update({
      where: { id: commitment.id },
      data: {
        status,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Fetches a commitment by ID scoped to tenant and case.
   */
  async getCommitmentById(
    merchantId: string,
    caseId: string,
    commitmentId: string,
  ): Promise<RecoveryCommitment | null> {
    const parentCase = await prisma.revenueRiskCase.findFirst({
      where: { id: caseId, merchantId },
    });
    if (!parentCase) return null;

    return prisma.recoveryCommitment.findFirst({
      where: { id: commitmentId, caseId },
    });
  }
}
