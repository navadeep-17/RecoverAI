import {
    AuditActorType,
    CaseStatus,
    HumanReview,
    PolicyDecision,
    RecoveryAction,
    ReviewStatus,
} from '@prisma/client';
import {
    ActionRepository,
    AuditRepository,
    CaseRepository,
    CommitmentRepository,
    CustomerRepository,
    HumanReviewRepository,
    HumanReviewWithRelations,
    MerchantRepository,
    OutcomeRepository,
    PolicyConfigRepository,
} from '@recoverai/db';
import { ReviewStateConflictError } from '@recoverai/shared';
import { ActionExecutionResult, ActionExecutor } from '../execution/action-executor.js';
import { IPolicyEngine, PolicyExecutionContext } from '../execution/policy-interface.js';

export interface HumanReviewServiceOptions {
  humanReviewRepo: HumanReviewRepository;
  caseRepo: CaseRepository;
  actionRepo: ActionRepository;
  customerRepo: CustomerRepository;
  merchantRepo: MerchantRepository;
  policyConfigRepo: PolicyConfigRepository;
  commitmentRepo: CommitmentRepository;
  outcomeRepo: OutcomeRepository;
  auditRepo: AuditRepository;
  policyEngine: IPolicyEngine;
  actionExecutor: ActionExecutor;
  clock?: () => Date;
}

export interface ReviewApprovalResult {
  approved: boolean;
  review?: HumanReview;
  action?: RecoveryAction | null;
  executionResult?: ActionExecutionResult;
  stale?: boolean;
  blockedByPolicy?: boolean;
  requiresReview?: boolean;
  policyDecision?: PolicyDecision;
  policyReasonCode?: string;
  rationale?: string;
  reason?: string;
  error?: string;
}

export interface ReviewRejectionResult {
  rejected: boolean;
  review?: HumanReview;
  reason?: string;
  error?: string;
}

export interface ReviewTakeoverResult {
  takenOver: boolean;
  review?: HumanReview;
  reason?: string;
  error?: string;
}

export interface ReviewCloseResult {
  closed: boolean;
  review?: HumanReview;
  reason?: string;
  error?: string;
}

export class HumanReviewService {
  private humanReviewRepo: HumanReviewRepository;
  private caseRepo: CaseRepository;
  private actionRepo: ActionRepository;
  private customerRepo: CustomerRepository;
  private merchantRepo: MerchantRepository;
  private policyConfigRepo: PolicyConfigRepository;
  private commitmentRepo: CommitmentRepository;
  private outcomeRepo: OutcomeRepository;
  private auditRepo: AuditRepository;
  private policyEngine: IPolicyEngine;
  private actionExecutor: ActionExecutor;
  private clock?: () => Date;

  constructor(options: HumanReviewServiceOptions) {
    this.humanReviewRepo = options.humanReviewRepo;
    this.caseRepo = options.caseRepo;
    this.actionRepo = options.actionRepo;
    this.customerRepo = options.customerRepo;
    this.merchantRepo = options.merchantRepo;
    this.policyConfigRepo = options.policyConfigRepo;
    this.commitmentRepo = options.commitmentRepo;
    this.outcomeRepo = options.outcomeRepo;
    this.auditRepo = options.auditRepo;
    this.policyEngine = options.policyEngine;
    this.actionExecutor = options.actionExecutor;
    this.clock = options.clock;
  }

  private now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  private async hasActiveHumanReviewGate(
    merchantId: string,
    caseId: string,
    excludedReviewId?: string,
  ): Promise<boolean> {
    if (!this.humanReviewRepo) {
      return false;
    }

    const pending = await this.humanReviewRepo.findPendingReviewForCase(merchantId, caseId);
    if (pending && (!excludedReviewId || pending.id !== excludedReviewId)) {
      return true;
    }

    const takeover = await this.humanReviewRepo.findActiveTakeoverForCase(merchantId, caseId);
    return !!takeover && (!excludedReviewId || takeover.id !== excludedReviewId);
  }

  private async reopenCaseIfReviewGateCleared(
    merchantId: string,
    caseId: string,
    excludedReviewId?: string,
  ): Promise<boolean> {
    const caseRecord = await this.caseRepo.getCaseById(merchantId, caseId);
    if (!caseRecord || caseRecord.status !== CaseStatus.NEEDS_REVIEW) {
      return false;
    }

    if (await this.hasActiveHumanReviewGate(merchantId, caseId, excludedReviewId)) {
      return false;
    }

    await this.caseRepo.compareAndSetStatus(
      merchantId,
      caseId,
      CaseStatus.NEEDS_REVIEW,
      CaseStatus.OPEN,
    );
    return true;
  }

  /**
   * Retrieves a review by ID scoped to merchant.
   */
  async getReviewById(merchantId: string, reviewId: string): Promise<HumanReviewWithRelations> {
    return this.humanReviewRepo.getReviewById(merchantId, reviewId);
  }

  /**
   * Lists reviews for a merchant with optional filtering.
   */
  async listReviews(
    merchantId: string,
    filter?: {
      status?: ReviewStatus;
      caseId?: string;
    },
  ): Promise<HumanReviewWithRelations[]> {
    return this.humanReviewRepo.listReviews(merchantId, filter);
  }

  /**
   * Requests a human review for a case.
   * Enforces tenant scoping, idempotency, terminal state rejection,
   * CAS transition of the case to NEEDS_REVIEW, and REVIEW_REQUESTED audit logging.
   */
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
    if (!caseRecord) {
      throw new Error(`Case "${caseId}" not found for merchant "${merchantId}"`);
    }

    // Terminal cases cannot have new human reviews created.
    if (
      caseRecord.status === CaseStatus.RECOVERED ||
      caseRecord.status === CaseStatus.STOPPED ||
      caseRecord.status === CaseStatus.EXHAUSTED
    ) {
      return {
        created: false,
        review: null,
        caseStatus: caseRecord.status,
        reason: `Case is in terminal state "${caseRecord.status}"; cannot request review`,
      };
    }

    let authoritativeCaseStatus = caseRecord.status;
    if (caseRecord.status === CaseStatus.OPEN || caseRecord.status === CaseStatus.WAITING) {
      try {
        await this.caseRepo.compareAndSetStatus(
          merchantId,
          caseId,
          caseRecord.status,
          CaseStatus.NEEDS_REVIEW,
        );
        authoritativeCaseStatus = CaseStatus.NEEDS_REVIEW;
      } catch {
        const reloadedCase = await this.caseRepo.getCaseById(merchantId, caseId);
        if (!reloadedCase) {
          throw new Error(`Case "${caseId}" not found for merchant "${merchantId}"`);
        }

        if (reloadedCase.status === CaseStatus.NEEDS_REVIEW) {
          authoritativeCaseStatus = CaseStatus.NEEDS_REVIEW;
        } else {
          return {
            created: false,
            review: null,
            caseStatus: reloadedCase.status,
            reason: `Case is no longer eligible for review; authoritative status is "${reloadedCase.status}"`,
          };
        }
      }
    }

    if (authoritativeCaseStatus !== CaseStatus.NEEDS_REVIEW) {
      return {
        created: false,
        review: null,
        caseStatus: authoritativeCaseStatus,
        reason: `Case is not eligible for human review; authoritative status is "${authoritativeCaseStatus}"`,
      };
    }

    // Create durable review idempotently bound to proposal/version.
    const createResult = await this.humanReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId: data.planVersionId,
      actionId: data.actionId,
      reviewKey: data.reviewKey,
      reasonForReview: data.reasonForReview,
    });

    const effectiveReview = createResult.review;
    const reviewAlreadyPending = effectiveReview.status === ReviewStatus.PENDING;

    if (createResult.created || reviewAlreadyPending) {
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'REVIEW_REQUESTED',
        actorType: data.actorType || AuditActorType.POLICY,
        inputSummaryJson: {
          reviewId: effectiveReview.id,
          planVersionId: data.planVersionId,
          actionId: data.actionId,
          reasonForReview: data.reasonForReview,
        },
        reasonCode: 'HUMAN_REVIEW_REQUESTED',
      });
    }

    return {
      created: createResult.created || reviewAlreadyPending,
      review: effectiveReview,
      caseStatus: CaseStatus.NEEDS_REVIEW,
    };
  }

  /**
   * Approves a stored human review proposal.
   *
   * Architectural Invariant:
   * 1. Reviewer identity & role (MERCHANT_ADMIN or REVIEWER) verified.
   * 2. Review status must be PENDING.
   * 3. Case must exist and still be in NEEDS_REVIEW.
   * 4. Stale approval protection: referenced plan/proposal must still be the authoritative latest version.
   * 5. Fresh PolicyEngine revalidation performed immediately before execution.
   * 6. If policy DENY or REVIEW -> 0 provider execution calls.
   * 7. If policy ALLOW -> ActionExecutor authorizes and executes exact proposal.
   */
  async approveReview(
    merchantId: string,
    reviewId: string,
    reviewerId: string,
    options?: { notes?: string },
  ): Promise<ReviewApprovalResult> {
    const currentTime = this.now();

    // 1. Load review with relations
    const review = await this.humanReviewRepo.getReviewById(merchantId, reviewId);
    if (!review) {
      throw new Error(`Human review "${reviewId}" not found for merchant "${merchantId}"`);
    }

    if (review.status !== ReviewStatus.PENDING) {
      throw new ReviewStateConflictError(reviewId, ReviewStatus.PENDING, review.status);
    }

    // 2. Load fresh case
    const caseRecord = await this.caseRepo.getCaseById(merchantId, review.caseId);
    if (!caseRecord) {
      throw new Error(`Case "${review.caseId}" not found for merchant "${merchantId}"`);
    }

    if (
      caseRecord.status === CaseStatus.RECOVERED ||
      caseRecord.status === CaseStatus.STOPPED ||
      caseRecord.status === CaseStatus.EXHAUSTED
    ) {
      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'REVIEW_STALE',
        actorType: AuditActorType.HUMAN,
        inputSummaryJson: {
          reviewId,
          reviewerId,
          caseStatus: caseRecord.status,
          reason: `Case status is ${caseRecord.status}; approval requires NEEDS_REVIEW`,
        },
        reasonCode: 'REVIEW_APPROVAL_REJECTED_TERMINAL',
      });
      return {
        approved: false,
        stale: true,
        reason: `Case is in terminal state "${caseRecord.status}"; approval is no longer valid`,
      };
    }

    if (caseRecord.status !== CaseStatus.NEEDS_REVIEW) {
      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'REVIEW_STALE',
        actorType: AuditActorType.HUMAN,
        inputSummaryJson: {
          reviewId,
          reviewerId,
          caseStatus: caseRecord.status,
          reason: `Case status is ${caseRecord.status}; approval requires NEEDS_REVIEW`,
        },
        reasonCode: 'REVIEW_APPROVAL_REJECTED_NOT_NEEDS_REVIEW',
      });
      return {
        approved: false,
        stale: true,
        reason: `Case must still be in NEEDS_REVIEW for this approval; authoritative status is "${caseRecord.status}"`,
      };
    }

    // 3. Stale Proposal Protection: verify plan version is still authoritative
    if (review.planVersionId) {
      const planVersions = caseRecord.planVersions || [];
      const latestPlanVersion = planVersions.length > 0
        ? planVersions.reduce((prev, curr) => (curr.version > prev.version ? curr : prev), planVersions[0])
        : null;

      if (latestPlanVersion && latestPlanVersion.id !== review.planVersionId) {
        await this.auditRepo.record(merchantId, {
          caseId: caseRecord.id,
          eventType: 'REVIEW_STALE',
          actorType: AuditActorType.HUMAN,
          inputSummaryJson: {
            reviewId,
            reviewerId,
            reviewPlanVersionId: review.planVersionId,
            latestPlanVersionId: latestPlanVersion.id,
            latestPlanVersion: latestPlanVersion.version,
          },
          reasonCode: 'STALE_PROPOSAL_SUPERSEDED',
        });

        return {
          approved: false,
          stale: true,
          reason: `Proposal version is stale. Current case plan version is v${latestPlanVersion.version}. Approval rejected without execution.`,
        };
      }
    }

    // 4. Kill Switch Safety Check (Fail Closed)
    let merchant;
    try {
      merchant = await this.merchantRepo.getMerchantById(merchantId);
    } catch {
      merchant = null;
    }

    if (!merchant || merchant.killSwitchActive) {
      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'REVIEW_EXECUTION_BLOCKED',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          reviewId,
          reviewerId,
          reason: merchant?.killSwitchActive ? 'Merchant kill switch is active' : 'Merchant safety state unavailable',
        },
        reasonCode: 'KILL_SWITCH_ACTIVE',
      });

      return {
        approved: false,
        blockedByPolicy: true,
        policyDecision: PolicyDecision.DENY,
        policyReasonCode: 'KILL_SWITCH_ACTIVE',
        rationale: 'Merchant kill switch is active; execution blocked',
      };
    }

    // 5. Fresh Policy Revalidation
    const policyConfig = await this.policyConfigRepo.getOrCreateConfig(merchantId);
    const priorActions = (caseRecord.actions || []).map((a) => ({
      actionType: a.actionType,
      executedAt: a.executedAt || a.createdAt,
      status: a.status,
      policyDecision: a.policyDecision,
      errorMessage: a.errorMessage,
    }));
    const priorOutcomes = (caseRecord.outcomes || []).map((o) => ({
      outcomeType: o.outcomeType,
      observedAt: o.observedAt,
      amountRecovered: o.amountRecovered?.toString() || null,
    }));
    const commitments = await this.commitmentRepo.getActiveCommitmentsForCase(merchantId, caseRecord.id);

    const boundPlanVersion = review.planVersion || (
      review.planVersionId
        ? (caseRecord.planVersions || []).find((pv) => pv.id === review.planVersionId)
        : null
    );

    const proposedActionType = boundPlanVersion
      ? boundPlanVersion.proposedActionType
      : review.action
      ? review.action.actionType
      : null;

    const proposedActionParams = boundPlanVersion
      ? (boundPlanVersion.proposedActionParams as Record<string, unknown>)
      : review.action
      ? (review.action.actionParams as Record<string, unknown>)
      : {};

    if (!proposedActionType) {
      throw new Error(`Review "${reviewId}" has no bound proposal or action to execute`);
    }

    const policyExecutionContext: PolicyExecutionContext = {
      merchantId,
      killSwitchActive: merchant.killSwitchActive,
      policyConfig: {
        maxRetriesPerCase: policyConfig.maxRetriesPerCase,
        maxContactsPerCase: policyConfig.maxContactsPerCase,
        maxActionsPerCase: policyConfig.maxActionsPerCase,
        cooldownHoursBetweenActions: policyConfig.cooldownHoursBetweenActions,
        highValueThreshold: policyConfig.highValueThreshold.toString(),
        minConfidenceThreshold: policyConfig.minConfidenceThreshold,
        reviewFirstMode: policyConfig.reviewFirstMode,
        checkoutAbandonmentThresholdMinutes: policyConfig.checkoutAbandonmentThresholdMinutes,
        quietHoursStart: policyConfig.quietHoursStart,
        quietHoursEnd: policyConfig.quietHoursEnd,
        quietHoursTimezone: policyConfig.quietHoursTimezone,
        maxRecoveryWindowDays: policyConfig.maxRecoveryWindowDays,
        overdueGracePeriodDays: policyConfig.overdueGracePeriodDays,
      },
      case: {
        id: caseRecord.id,
        merchantId: caseRecord.merchantId,
        riskType: caseRecord.riskType,
        amountAtRisk: caseRecord.amountAtRisk.toString(),
        currency: caseRecord.currency,
        status: caseRecord.status,
        openedAt: caseRecord.openedAt,
        diagnosisCode: boundPlanVersion ? boundPlanVersion.diagnosisCode : 'HUMAN_APPROVED',
      },
      customer: caseRecord.customer
        ? {
            id: caseRecord.customer.id,
            contactConsent: caseRecord.customer.contactConsent,
            optedOut: caseRecord.customer.optedOut,
            lastContactedAt: caseRecord.customer.lastContactedAt,
          }
        : null,
      proposedActionType,
      proposedActionParams,
      confidence: review.planVersion ? review.planVersion.confidence : 1.0,
      diagnosisCode: review.planVersion ? review.planVersion.diagnosisCode : 'HUMAN_APPROVED',
      diagnosisSummary: review.planVersion ? review.planVersion.diagnosisSummary : 'Human approved review',
      verifiedPaymentFailureCode:
        typeof (caseRecord.contextJson as Record<string, unknown> | null)?.verifiedPaymentFailureCode === 'string'
          ? ((caseRecord.contextJson as Record<string, unknown>).verifiedPaymentFailureCode as string)
          : null,
      shouldEscalate: false,
      shouldStop: false,
      priorActions,
      priorOutcomes,
      activeCommitments: commitments.map((c) => ({
        id: c.id,
        promisedAmount: c.promisedAmount.toString(),
        promisedDate: c.promisedDate,
        status: c.status,
      })),
      currentTime,
      executionSource: 'HUMAN_REVIEW_APPROVAL',
    };

    const policyEvaluation = this.policyEngine.evaluate(policyExecutionContext);

    // 6. Enforce Fresh Policy Decision
    if (policyEvaluation.decision === PolicyDecision.DENY) {
      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'REVIEW_EXECUTION_BLOCKED',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          reviewId,
          reviewerId,
          proposedActionType,
          reasonCode: policyEvaluation.reasonCode,
          rationale: policyEvaluation.rationale,
        },
        reasonCode: policyEvaluation.reasonCode,
      });

      return {
        approved: false,
        blockedByPolicy: true,
        policyDecision: PolicyDecision.DENY,
        policyReasonCode: policyEvaluation.reasonCode,
        rationale: policyEvaluation.rationale,
        reason: `Fresh policy evaluation blocked execution: ${policyEvaluation.rationale}`,
      };
    }

    if (policyEvaluation.decision === PolicyDecision.REVIEW) {
      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'REVIEW_EXECUTION_BLOCKED',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          reviewId,
          reviewerId,
          proposedActionType,
          reasonCode: policyEvaluation.reasonCode,
          rationale: policyEvaluation.rationale,
        },
        reasonCode: policyEvaluation.reasonCode,
      });

      return {
        approved: false,
        requiresReview: true,
        policyDecision: PolicyDecision.REVIEW,
        policyReasonCode: policyEvaluation.reasonCode,
        rationale: policyEvaluation.rationale,
        reason: `Fresh policy evaluation requires continued review: ${policyEvaluation.rationale}`,
      };
    }

    // 7. Policy is ALLOW -> Resolve review atomically via CAS
    const updatedReview = await this.humanReviewRepo.resolveReview(merchantId, reviewId, {
      reviewerId,
      status: ReviewStatus.APPROVED,
      expectedStatus: ReviewStatus.PENDING,
      reviewDecision: 'APPROVED',
      reviewNotes: options?.notes,
      revalidatedPolicyDecision: PolicyDecision.ALLOW,
      revalidatedAt: currentTime,
      resolvedAt: currentTime,
    });

    await this.auditRepo.record(merchantId, {
      caseId: caseRecord.id,
      eventType: 'REVIEW_APPROVED',
      actorType: AuditActorType.HUMAN,
      inputSummaryJson: {
        reviewId,
        reviewerId,
        planVersionId: review.planVersionId,
        notes: options?.notes,
      },
      reasonCode: 'HUMAN_APPROVAL_GRANTED',
    });

    await this.auditRepo.record(merchantId, {
      caseId: caseRecord.id,
      eventType: 'REVIEW_EXECUTION_AUTHORIZED',
      actorType: AuditActorType.POLICY,
      inputSummaryJson: {
        reviewId,
        reviewerId,
        proposedActionType,
        policyDecision: PolicyDecision.ALLOW,
      },
      reasonCode: 'POLICY_REVALIDATION_ALLOWED',
    });

    // 8. Authorize and Execute Action via ActionExecutor
    const authResult = await this.actionExecutor.authorizeAndCreateAction(merchantId, caseRecord.id, {
      planVersionId: review.planVersionId || undefined,
      actionType: proposedActionType,
      actionParams: proposedActionParams,
      policyEvaluation,
      attemptOrVersion: review.planVersion ? review.planVersion.version : 1,
      reviewId: updatedReview.id,
    });

    if (!authResult.authorized || !authResult.action) {
      return {
        approved: true,
        review: updatedReview,
        error: authResult.reason || 'Failed to authorize action execution',
      };
    }

    const executionResult = await this.actionExecutor.executeAction(merchantId, authResult.action.id);

    return {
      approved: true,
      review: updatedReview,
      action: executionResult.action,
      executionResult,
    };
  }

  /**
   * Rejects a review proposal.
   * Atomically transitions review PENDING -> REJECTED, records audit,
   * and transitions case NEEDS_REVIEW -> OPEN to allow autonomous recovery to continue.
   */
  async rejectReview(
    merchantId: string,
    reviewId: string,
    reviewerId: string,
    options: { reason: string; notes?: string },
  ): Promise<ReviewRejectionResult> {
    const currentTime = this.now();

    const review = await this.humanReviewRepo.getReviewById(merchantId, reviewId);
    if (!review) {
      throw new Error(`Human review "${reviewId}" not found for merchant "${merchantId}"`);
    }

    if (review.status !== ReviewStatus.PENDING) {
      throw new ReviewStateConflictError(reviewId, ReviewStatus.PENDING, review.status);
    }

    const updatedReview = await this.humanReviewRepo.resolveReview(merchantId, reviewId, {
      reviewerId,
      status: ReviewStatus.REJECTED,
      expectedStatus: ReviewStatus.PENDING,
      reviewDecision: 'REJECTED',
      reviewNotes: options.notes ? `${options.reason}: ${options.notes}` : options.reason,
      resolvedAt: currentTime,
    });

    await this.auditRepo.record(merchantId, {
      caseId: review.caseId,
      eventType: 'REVIEW_REJECTED',
      actorType: AuditActorType.HUMAN,
      inputSummaryJson: {
        reviewId,
        reviewerId,
        reason: options.reason,
        notes: options.notes,
      },
      reasonCode: 'HUMAN_REVIEW_REJECTED',
    });

    // Reopen only when there is no remaining active review gate for the case.
    const caseRecord = await this.caseRepo.getCaseById(merchantId, review.caseId);
    if (caseRecord && caseRecord.status === CaseStatus.NEEDS_REVIEW) {
      const activeGateRemains = await this.hasActiveHumanReviewGate(merchantId, caseRecord.id, updatedReview.id);
      if (!activeGateRemains) {
        await this.caseRepo.compareAndSetStatus(merchantId, caseRecord.id, CaseStatus.NEEDS_REVIEW, CaseStatus.OPEN);
      }
    }

    return {
      rejected: true,
      review: updatedReview,
    };
  }

  /**
   * Human takeover: stops automation from acting autonomously on the case.
   * Atomically transitions review PENDING -> TAKEN_OVER and records audit.
   */
  async takeOverReview(
    merchantId: string,
    reviewId: string,
    reviewerId: string,
    options?: { notes?: string },
  ): Promise<ReviewTakeoverResult> {
    const currentTime = this.now();

    const review = await this.humanReviewRepo.getReviewById(merchantId, reviewId);
    if (!review) {
      throw new Error(`Human review "${reviewId}" not found for merchant "${merchantId}"`);
    }

    if (review.status !== ReviewStatus.PENDING) {
      throw new ReviewStateConflictError(reviewId, ReviewStatus.PENDING, review.status);
    }

    const updatedReview = await this.humanReviewRepo.resolveReview(merchantId, reviewId, {
      reviewerId,
      status: ReviewStatus.TAKEN_OVER,
      expectedStatus: ReviewStatus.PENDING,
      reviewDecision: 'TAKEN_OVER',
      reviewNotes: options?.notes,
      resolvedAt: currentTime,
    });

    await this.auditRepo.record(merchantId, {
      caseId: review.caseId,
      eventType: 'REVIEW_TAKEN_OVER',
      actorType: AuditActorType.HUMAN,
      inputSummaryJson: {
        reviewId,
        reviewerId,
        notes: options?.notes,
      },
      reasonCode: 'HUMAN_TAKEOVER',
    });

    return {
      takenOver: true,
      review: updatedReview,
    };
  }

  /**
   * Closes a review and optionally stops case recovery administratively.
   */
  async closeReview(
    merchantId: string,
    reviewId: string,
    reviewerId: string,
    options: { reason: string; notes?: string; stopCase?: boolean },
  ): Promise<ReviewCloseResult> {
    const currentTime = this.now();

    const review = await this.humanReviewRepo.getReviewById(merchantId, reviewId);
    if (!review) {
      throw new Error(`Human review "${reviewId}" not found for merchant "${merchantId}"`);
    }

    const updatedReview = await this.humanReviewRepo.resolveReview(merchantId, reviewId, {
      reviewerId,
      status: ReviewStatus.CLOSED,
      expectedStatus: ReviewStatus.PENDING,
      reviewDecision: 'CLOSED',
      reviewNotes: options.notes ? `${options.reason}: ${options.notes}` : options.reason,
      resolvedAt: currentTime,
    });

    await this.auditRepo.record(merchantId, {
      caseId: review.caseId,
      eventType: 'REVIEW_CLOSED',
      actorType: AuditActorType.HUMAN,
      inputSummaryJson: {
        reviewId,
        reviewerId,
        reason: options.reason,
        notes: options.notes,
        stopCase: options.stopCase,
      },
      reasonCode: 'HUMAN_REVIEW_CLOSED',
    });

    if (options.stopCase !== false) {
      const caseRecord = await this.caseRepo.getCaseById(merchantId, review.caseId);
      if (
        caseRecord &&
        caseRecord.status !== CaseStatus.RECOVERED &&
        caseRecord.status !== CaseStatus.STOPPED &&
        caseRecord.status !== CaseStatus.EXHAUSTED
      ) {
        await this.caseRepo.compareAndSetStatus(merchantId, caseRecord.id, caseRecord.status, CaseStatus.STOPPED);
        await this.auditRepo.record(merchantId, {
          caseId: caseRecord.id,
          eventType: 'STOP_RECOVERY',
          actorType: AuditActorType.HUMAN,
          inputSummaryJson: {
            reviewId,
            reviewerId,
            reason: options.reason,
          },
          reasonCode: 'ADMINISTRATIVE_STOP',
        });
      }
    } else {
      await this.reopenCaseIfReviewGateCleared(merchantId, review.caseId, updatedReview.id);
    }

    return {
      closed: true,
      review: updatedReview,
    };
  }
}
