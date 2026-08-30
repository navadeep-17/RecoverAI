import { AuditActorType, CaseStatus, HumanReview } from '@prisma/client';

/**
 * Narrow authority boundary for every transition into NEEDS_REVIEW.
 * HumanReviewService is the sole production implementation: callers may not
 * flip a case status without also durably creating (or finding) its review gate.
 */
export interface ReviewGateRequester {
  requestReview(
    merchantId: string,
    caseId: string,
    data: {
      planVersionId?: string;
      actionId?: string;
      reviewKey?: string;
      reasonForReview: string;
      actorType?: AuditActorType;
    },
  ): Promise<{ created: boolean; review: HumanReview | null; caseStatus: CaseStatus; reason?: string }>;
  reconcileTerminalCase(merchantId: string, caseId: string, caseStatus: CaseStatus): Promise<void>;
}
