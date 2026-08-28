import { Prisma, RecoveryCommitment } from '@prisma/client';
import { prisma } from '../client.js';

export interface CreateCommitmentParams {
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
  extractedFromText?: string;
  /**
   * Initial status (defaults to 'PENDING').
   */
  status?: string;
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
   * Persists an authoritative RecoveryCommitment under a tenant-scoped case.
   *
   * Verifies that the case belongs to the merchantId before creating.
   */
  async createCommitment(
    merchantId: string,
    caseId: string,
    params: CreateCommitmentParams,
  ): Promise<RecoveryCommitment> {
    // Assert tenant ownership of the parent case
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    return prisma.recoveryCommitment.create({
      data: {
        caseId,
        promisedAmount: new Prisma.Decimal(params.promisedAmount),
        promisedDate: params.promisedDate,
        extractedFromText: params.extractedFromText,
        status: params.status || 'PENDING',
      },
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
