import { AuditActorType, CaseStatus, HumanReview } from '@prisma/client';
import { AuditRepository, CaseRepository, HumanReviewRepository } from '@recoverai/db';
import { ReviewGateRequester } from './review-gate-requester.js';

/** The single persisted lifecycle for routing a case to durable human review. */
export class DurableReviewGateService implements ReviewGateRequester {
  constructor(
    private readonly humanReviewRepo: HumanReviewRepository,
    private readonly caseRepo: CaseRepository,
    private readonly auditRepo: AuditRepository,
  ) {}

  private isTerminal(status: CaseStatus): boolean {
    return status === CaseStatus.RECOVERED || status === CaseStatus.STOPPED || status === CaseStatus.EXHAUSTED;
  }

  async reconcileTerminalCase(
    merchantId: string,
    caseId: string,
    caseStatus: CaseStatus,
    reasonCode = 'TERMINAL_CASE_REVIEW_RECONCILIATION',
  ): Promise<void> {
    if (!this.isTerminal(caseStatus)) return;
    const closedCount = await this.humanReviewRepo.closeActiveReviewsForCase(
      merchantId,
      caseId,
      `Case became ${caseStatus} while human-review gate reconciliation was in progress.`,
    );
    if (closedCount > 0) {
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'REVIEW_STALE',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { caseStatus, closedReviewCount: closedCount },
        reasonCode,
      });
    }
  }

  async requestReview(
    merchantId: string,
    caseId: string,
    data: {
      planVersionId?: string;
      actionId?: string;
      reviewKey?: string;
      reasonForReview: string;
      actorType?: AuditActorType;
    },
  ): Promise<{ created: boolean; review: HumanReview | null; caseStatus: CaseStatus; reason?: string }> {
    const caseRecord = await this.caseRepo.getCaseById(merchantId, caseId);
    if (!caseRecord) throw new Error(`Case "${caseId}" not found for merchant "${merchantId}"`);
    if (this.isTerminal(caseRecord.status)) {
      return { created: false, review: null, caseStatus: caseRecord.status, reason: `Case is in terminal state "${caseRecord.status}"; cannot request review` };
    }

    let status = caseRecord.status;
    if (status === CaseStatus.OPEN || status === CaseStatus.WAITING) {
      try {
        await this.caseRepo.compareAndSetStatus(merchantId, caseId, status, CaseStatus.NEEDS_REVIEW);
        status = CaseStatus.NEEDS_REVIEW;
      } catch {
        const reloaded = await this.caseRepo.getCaseById(merchantId, caseId);
        if (!reloaded) throw new Error(`Case "${caseId}" not found for merchant "${merchantId}"`);
        status = reloaded.status;
      }
    }
    if (status !== CaseStatus.NEEDS_REVIEW) {
      return { created: false, review: null, caseStatus: status, reason: `Case is not eligible for human review; authoritative status is "${status}"` };
    }

    const created = await this.humanReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId: data.planVersionId,
      actionId: data.actionId,
      reviewKey: data.reviewKey,
      reasonForReview: data.reasonForReview,
    });
    if (created.created) {
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'REVIEW_REQUESTED',
        actorType: data.actorType || AuditActorType.POLICY,
        inputSummaryJson: { reviewId: created.review.id, planVersionId: data.planVersionId, actionId: data.actionId, reasonForReview: data.reasonForReview },
        reasonCode: 'HUMAN_REVIEW_REQUESTED',
      });
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const authoritative = await this.caseRepo.getCaseById(merchantId, caseId);
      if (!authoritative) throw new Error(`Case "${caseId}" not found for merchant "${merchantId}"`);
      if (authoritative.status === CaseStatus.NEEDS_REVIEW) {
        return { created: created.created, review: created.review, caseStatus: CaseStatus.NEEDS_REVIEW };
      }
      if (this.isTerminal(authoritative.status)) {
        await this.reconcileTerminalCase(merchantId, caseId, authoritative.status, 'REVIEW_CREATION_TERMINAL_CASE_RACE');
        return {
          created: false,
          review: await this.humanReviewRepo.getReviewById(merchantId, created.review.id),
          caseStatus: authoritative.status,
          reason: `Case became terminal (${authoritative.status}) during review creation; active review gate was invalidated`,
        };
      }
      if (authoritative.status === CaseStatus.OPEN || authoritative.status === CaseStatus.WAITING) {
        try {
          await this.caseRepo.compareAndSetStatus(merchantId, caseId, authoritative.status, CaseStatus.NEEDS_REVIEW);
        } catch {
          // A terminal transition may have won; reload on the bounded retry.
        }
      }
    }
    const finalCase = await this.caseRepo.getCaseById(merchantId, caseId);
    if (!finalCase) throw new Error(`Case "${caseId}" not found for merchant "${merchantId}"`);
    if (this.isTerminal(finalCase.status)) await this.reconcileTerminalCase(merchantId, caseId, finalCase.status, 'REVIEW_CREATION_TERMINAL_CASE_RACE');
    return {
      created: false,
      review: await this.humanReviewRepo.getReviewById(merchantId, created.review.id),
      caseStatus: finalCase.status,
      reason: `Review gate reconciliation did not converge; authoritative case status is "${finalCase.status}"`,
    };
  }
}
