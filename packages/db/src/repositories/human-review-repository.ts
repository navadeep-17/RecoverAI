import {
  HumanReview,
  ReviewStatus,
  PolicyDecision,
  Role,
  RevenueRiskCase,
  RecoveryPlanVersion,
  RecoveryAction,
  User,
} from '@prisma/client';
import { ReviewStateConflictError, UnauthorizedReviewerError } from '@recoverai/shared';
import { prisma } from '../client.js';

export type HumanReviewWithRelations = HumanReview & {
  case?: RevenueRiskCase | null;
  planVersion?: RecoveryPlanVersion | null;
  action?: RecoveryAction | null;
  reviewer?: User | null;
};

export class HumanReviewRepository {
  /**
   * Creates a durable HumanReview idempotently bound to a case and authoritative proposal/version.
   * If an active PENDING review already exists for this case/planVersion, returns the existing review.
   */
  async createReview(
    merchantId: string,
    data: {
      caseId: string;
      planVersionId?: string;
      actionId?: string;
      reasonForReview: string;
    },
  ): Promise<HumanReview> {
    // Assert tenant ownership of the case
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: data.caseId, merchantId },
    });

    // If planVersionId is supplied, assert that planVersion belongs to this case
    if (data.planVersionId) {
      await prisma.recoveryPlanVersion.findFirstOrThrow({
        where: {
          id: data.planVersionId,
          caseId: data.caseId,
        },
      });
    }

    // If actionId is supplied, assert that action belongs to this case and merchant
    if (data.actionId) {
      await prisma.recoveryAction.findFirstOrThrow({
        where: {
          id: data.actionId,
          caseId: data.caseId,
          case: { merchantId },
        },
      });
    }

    // Check for an existing PENDING review for this case (and matching planVersionId if provided)
    const existingPending = await prisma.humanReview.findFirst({
      where: {
        merchantId,
        caseId: data.caseId,
        status: ReviewStatus.PENDING,
        ...(data.planVersionId ? { planVersionId: data.planVersionId } : {}),
      },
    });

    if (existingPending) {
      return existingPending;
    }

    return prisma.humanReview.create({
      data: {
        merchantId,
        caseId: data.caseId,
        planVersionId: data.planVersionId,
        actionId: data.actionId,
        reasonForReview: data.reasonForReview,
        status: ReviewStatus.PENDING,
      },
    });
  }

  /**
   * Retrieves a HumanReview by ID and verifies merchant tenant isolation.
   */
  async getReviewById(merchantId: string, reviewId: string): Promise<HumanReviewWithRelations> {
    return prisma.humanReview.findFirstOrThrow({
      where: { id: reviewId, merchantId },
      include: {
        case: true,
        planVersion: true,
        action: true,
        reviewer: true,
      },
    });
  }

  /**
   * Lists reviews for a merchant, optionally filtered by status and caseId.
   */
  async listReviews(
    merchantId: string,
    filter?: {
      status?: ReviewStatus;
      caseId?: string;
    },
  ): Promise<HumanReviewWithRelations[]> {
    return prisma.humanReview.findMany({
      where: {
        merchantId,
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.caseId ? { caseId: filter.caseId } : {}),
      },
      include: {
        case: true,
        planVersion: true,
        action: true,
        reviewer: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Lists active PENDING reviews for a merchant.
   */
  async listPending(merchantId: string): Promise<HumanReviewWithRelations[]> {
    return this.listReviews(merchantId, { status: ReviewStatus.PENDING });
  }

  /**
   * Finds any active PENDING review for a case.
   */
  async findPendingReviewForCase(merchantId: string, caseId: string): Promise<HumanReviewWithRelations | null> {
    return prisma.humanReview.findFirst({
      where: {
        merchantId,
        caseId,
        status: ReviewStatus.PENDING,
      },
      include: {
        case: true,
        planVersion: true,
        action: true,
        reviewer: true,
      },
    });
  }

  /**
   * Finds any active TAKEN_OVER review for a case.
   */
  async findActiveTakeoverForCase(merchantId: string, caseId: string): Promise<HumanReviewWithRelations | null> {
    return prisma.humanReview.findFirst({
      where: {
        merchantId,
        caseId,
        status: ReviewStatus.TAKEN_OVER,
      },
      include: {
        case: true,
        planVersion: true,
        action: true,
        reviewer: true,
      },
    });
  }

  /**
   * Atomically resolves a review via optimistic concurrency (CAS).
   * Verifies reviewer identity and role (MERCHANT_ADMIN or REVIEWER).
   * Throws ReviewStateConflictError if another concurrent operation already resolved the review.
   */
  async resolveReview(
    merchantId: string,
    reviewId: string,
    data: {
      reviewerId: string;
      status: ReviewStatus;
      expectedStatus?: ReviewStatus;
      reviewDecision?: string;
      reviewNotes?: string;
      revalidatedPolicyDecision?: PolicyDecision;
      revalidatedAt?: Date;
      resolvedAt?: Date;
    },
  ): Promise<HumanReview> {
    // 1. Verify reviewer belongs to merchant and has permitted role
    const reviewer = await prisma.user.findFirst({
      where: { id: data.reviewerId, merchantId },
    });

    if (!reviewer) {
      throw new UnauthorizedReviewerError(
        data.reviewerId,
        merchantId,
        'Reviewer not found in merchant organization',
      );
    }

    if (reviewer.role !== Role.MERCHANT_ADMIN && reviewer.role !== Role.REVIEWER) {
      throw new UnauthorizedReviewerError(
        data.reviewerId,
        merchantId,
        `Role "${reviewer.role}" is not permitted to resolve human reviews`,
      );
    }

    const expected = data.expectedStatus ?? ReviewStatus.PENDING;
    const now = new Date();

    // 2. Perform atomic CAS update
    const updateResult = await prisma.humanReview.updateMany({
      where: {
        id: reviewId,
        merchantId,
        status: expected,
      },
      data: {
        reviewerId: data.reviewerId,
        status: data.status,
        reviewDecision: data.reviewDecision,
        reviewNotes: data.reviewNotes,
        revalidatedPolicyDecision: data.revalidatedPolicyDecision,
        revalidatedAt: data.revalidatedAt || (data.revalidatedPolicyDecision ? now : undefined),
        resolvedAt: data.resolvedAt || now,
      },
    });

    if (updateResult.count === 0) {
      // Fetch current row to determine if it's missing or in a conflicting state
      const current = await prisma.humanReview.findFirst({
        where: { id: reviewId, merchantId },
      });

      if (!current) {
        throw new Error(`Human review "${reviewId}" not found for merchant "${merchantId}"`);
      }

      throw new ReviewStateConflictError(reviewId, expected, current.status);
    }

    return prisma.humanReview.findUniqueOrThrow({
      where: { id: reviewId },
    });
  }
}
