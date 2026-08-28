import { HumanReview, ReviewStatus, PolicyDecision } from '@prisma/client';
import { prisma } from '../client.js';

export class HumanReviewRepository {
  async createReview(
    merchantId: string,
    data: {
      caseId: string;
      actionId?: string;
      reasonForReview: string;
    },
  ): Promise<HumanReview> {
    return prisma.humanReview.create({
      data: {
        merchantId,
        caseId: data.caseId,
        actionId: data.actionId,
        reasonForReview: data.reasonForReview,
        status: ReviewStatus.PENDING,
      },
    });
  }

  async listPending(merchantId: string): Promise<HumanReview[]> {
    return prisma.humanReview.findMany({
      where: {
        merchantId,
        status: ReviewStatus.PENDING,
      },
      include: {
        case: true,
        action: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async resolveReview(
    merchantId: string,
    reviewId: string,
    data: {
      reviewerId: string;
      status: ReviewStatus;
      reviewDecision?: string;
      reviewNotes?: string;
      revalidatedPolicyDecision?: PolicyDecision;
    },
  ): Promise<HumanReview> {
    const existing = await prisma.humanReview.findFirstOrThrow({
      where: { id: reviewId, merchantId },
    });

    if (existing.status !== ReviewStatus.PENDING) {
      throw new Error(`Human review ${reviewId} has already been resolved with status ${existing.status}`);
    }

    return prisma.humanReview.update({
      where: { id: reviewId },
      data: {
        reviewerId: data.reviewerId,
        status: data.status,
        reviewDecision: data.reviewDecision,
        reviewNotes: data.reviewNotes,
        revalidatedPolicyDecision: data.revalidatedPolicyDecision,
        revalidatedAt: new Date(),
        resolvedAt: new Date(),
      },
    });
  }
}
