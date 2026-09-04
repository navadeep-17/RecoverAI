import {
  Prisma,
  HumanReview,
  CaseStatus,
  ReviewStatus,
  PolicyDecision,
  Role,
  RevenueRiskCase,
  RecoveryPlanVersion,
  RecoveryAction,
  User,
} from '@prisma/client';
import {
  CaseStateConflictError,
  ReviewStateConflictError,
  UnauthorizedReviewerError,
  validateCaseTransition,
} from '@recoverai/shared';
import { prisma } from '../client.js';

export type HumanReviewWithRelations = HumanReview & {
  case?: RevenueRiskCase | null;
  planVersion?: RecoveryPlanVersion | null;
  action?: RecoveryAction | null;
  reviewer?: User | null;
};

export interface CreateReviewResult {
  created: boolean;
  review: HumanReview;
}

export class HumanReviewRepository {
  private async assertAuthorizedReviewer(merchantId: string, reviewerId: string): Promise<void> {
    const reviewer = await prisma.user.findFirst({
      where: { id: reviewerId, merchantId },
    });

    if (!reviewer) {
      throw new UnauthorizedReviewerError(
        reviewerId,
        merchantId,
        'Reviewer not found in merchant organization',
      );
    }

    if (reviewer.role !== Role.MERCHANT_ADMIN && reviewer.role !== Role.REVIEWER) {
      throw new UnauthorizedReviewerError(
        reviewerId,
        merchantId,
        `Role "${reviewer.role}" is not permitted to resolve human reviews`,
      );
    }
  }

  /**
   * Closes active review gates when the authoritative case can no longer be
   * reviewed. This is a system reconciliation path, not a human resolution,
   * so it deliberately does not require a reviewer identity.
   */
  async closeActiveReviewsForCase(
    merchantId: string,
    caseId: string,
    reason: string,
  ): Promise<number> {
    const result = await prisma.humanReview.updateMany({
      where: {
        merchantId,
        caseId,
        status: { in: [ReviewStatus.PENDING, ReviewStatus.TAKEN_OVER] },
      },
      data: {
        status: ReviewStatus.CLOSED,
        reviewDecision: 'INVALIDATED_BY_CASE_STATE',
        reviewNotes: reason,
        resolvedAt: new Date(),
      },
    });

    return result.count;
  }

  /**
   * Creates a durable HumanReview idempotently bound to a case and authoritative proposal/version.
   * Catches unique constraint collisions (P2002 on [merchantId, caseId, reviewKey]) and returns existing review.
   */
  async createReview(
    merchantId: string,
    data: {
      caseId: string;
      planVersionId?: string;
      actionId?: string;
      reviewKey?: string;
      reasonForReview: string;
    },
  ): Promise<CreateReviewResult> {
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

    const reviewKey = data.reviewKey || (
      data.planVersionId
        ? `plan:${data.planVersionId}`
        : (data.actionId ? `action:${data.actionId}` : `case:${data.caseId}`)
    );

    try {
      const review = await prisma.humanReview.create({
        data: {
          merchantId,
          caseId: data.caseId,
          planVersionId: data.planVersionId,
          actionId: data.actionId,
          reviewKey,
          reasonForReview: data.reasonForReview,
          status: ReviewStatus.PENDING,
        },
      });

      return { created: true, review };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await prisma.humanReview.findFirstOrThrow({
          where: {
            merchantId,
            caseId: data.caseId,
            reviewKey,
          },
        });
        return { created: false, review: existing };
      }
      throw err;
    }
  }

  /**
   * Retrieves a HumanReview by ID and verifies merchant tenant isolation.
   */
  async getReviewById(merchantId: string, reviewId: string): Promise<HumanReviewWithRelations> {
    return prisma.humanReview.findFirstOrThrow({
      where: { id: reviewId, merchantId },
      include: {
        case: { include: { customer: true } },
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
        case: { include: { customer: true } },
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
        case: { include: { customer: true } },
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
        case: { include: { customer: true } },
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
    await this.assertAuthorizedReviewer(merchantId, data.reviewerId);

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

  /**
   * Atomically claims a pending approval and restores the reviewed case to the
   * canonical executable WAITING state. Either both CAS operations commit or
   * neither does, so a case-state race cannot leave behind approval authority.
   */
  async approveReviewAndContinueCase(
    merchantId: string,
    reviewId: string,
    caseId: string,
    data: {
      reviewerId: string;
      reviewNotes?: string;
      revalidatedAt: Date;
      resolvedAt: Date;
    },
  ): Promise<HumanReview> {
    await this.assertAuthorizedReviewer(merchantId, data.reviewerId);
    validateCaseTransition(CaseStatus.NEEDS_REVIEW, CaseStatus.WAITING, caseId);

    return prisma.$transaction(async (transaction) => {
      const reviewUpdate = await transaction.humanReview.updateMany({
        where: {
          id: reviewId,
          merchantId,
          caseId,
          status: ReviewStatus.PENDING,
        },
        data: {
          reviewerId: data.reviewerId,
          status: ReviewStatus.APPROVED,
          reviewDecision: 'APPROVED',
          reviewNotes: data.reviewNotes,
          revalidatedPolicyDecision: PolicyDecision.ALLOW,
          revalidatedAt: data.revalidatedAt,
          resolvedAt: data.resolvedAt,
        },
      });

      if (reviewUpdate.count === 0) {
        const current = await transaction.humanReview.findFirst({
          where: { id: reviewId, merchantId },
        });
        if (!current) {
          throw new Error(`Human review "${reviewId}" not found for merchant "${merchantId}"`);
        }
        throw new ReviewStateConflictError(reviewId, ReviewStatus.PENDING, current.status);
      }

      const caseUpdate = await transaction.revenueRiskCase.updateMany({
        where: {
          id: caseId,
          merchantId,
          status: CaseStatus.NEEDS_REVIEW,
        },
        data: { status: CaseStatus.WAITING },
      });

      if (caseUpdate.count === 0) {
        throw new CaseStateConflictError(
          `Concurrent modification conflict on case ${caseId}: expected status was ${CaseStatus.NEEDS_REVIEW} but row was modified concurrently`,
          caseId,
          CaseStatus.NEEDS_REVIEW,
          CaseStatus.WAITING,
        );
      }

      return transaction.humanReview.findUniqueOrThrow({ where: { id: reviewId } });
    });
  }
}
