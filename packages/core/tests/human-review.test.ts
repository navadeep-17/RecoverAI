import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ActionExecutionStatus,
  AuditActorType,
  CaseStatus,
  PolicyDecision,
  RecoveryActionType,
  ReviewStatus,
  RiskType,
} from '@prisma/client';
import {
  ActionExecutor,
  HumanReviewService,
} from '../src/index.js';
import { PolicyEngine } from '@recoverai/policy';
import { ProviderRegistry, SimulatedRecoveryProvider } from '@recoverai/integrations';
import { ReviewStateConflictError, UnauthorizedReviewerError } from '@recoverai/shared';

describe('HumanReviewService Unit Tests', () => {
  let reviewService: HumanReviewService;
  let actionExecutor: ActionExecutor;
  let mockReviewRepo: any;
  let mockCaseRepo: any;
  let mockActionRepo: any;
  let mockCustomerRepo: any;
  let mockMerchantRepo: any;
  let mockPolicyConfigRepo: any;
  let mockCommitmentRepo: any;
  let mockOutcomeRepo: any;
  let mockAuditRepo: any;
  let policyEngine: PolicyEngine;
  let simulatedProvider: SimulatedRecoveryProvider;
  let providerRegistry: ProviderRegistry;

  const merchantId = 'mch_review_unit_01';
  const otherMerchantId = 'mch_review_unit_02';
  const caseId = 'case_review_unit_01';
  const customerId = 'cust_review_unit_01';
  const reviewerId = 'usr_reviewer_01';
  const planVersionId = 'pv_review_unit_01';

  let inMemoryReviews: Map<string, any>;
  let inMemoryCases: Map<string, any>;
  let inMemoryCustomers: Map<string, any>;
  let inMemoryMerchants: Map<string, any>;
  let inMemoryActions: Map<string, any>;
  let inMemoryAudits: any[];

  beforeEach(() => {
    inMemoryReviews = new Map();
    inMemoryCases = new Map();
    inMemoryCustomers = new Map();
    inMemoryMerchants = new Map();
    inMemoryActions = new Map();
    inMemoryAudits = [];

    inMemoryMerchants.set(merchantId, {
      id: merchantId,
      name: 'Test Merchant',
      killSwitchActive: false,
    });

    inMemoryCustomers.set(customerId, {
      id: customerId,
      merchantId,
      name: 'Jane Doe',
      email: 'jane@example.com',
      phone: '+919876543210',
      contactConsent: true,
      optedOut: false,
      lastContactedAt: null,
    });

    inMemoryCases.set(caseId, {
      id: caseId,
      merchantId,
      customerId,
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: { toString: () => '1500.00' },
      currency: 'INR',
      status: CaseStatus.NEEDS_REVIEW,
      openedAt: new Date(Date.now() - 3600000),
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
      customer: inMemoryCustomers.get(customerId),
      planVersions: [
        {
          id: planVersionId,
          caseId,
          version: 1,
          diagnosisCode: 'CARD_DECLINED',
          diagnosisSummary: 'Card declined due to temporary bank error',
          proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
          proposedActionParams: { channel: 'EMAIL', discountOffered: 0 },
          confidence: 0.9,
          createdAt: new Date(),
        },
      ],
      actions: [],
      outcomes: [],
    });

    mockReviewRepo = {
      createReview: vi.fn(async (mId: string, data: any) => {
        const reviewKey = data.reviewKey || (
          data.planVersionId ? `plan:${data.planVersionId}` : (data.actionId ? `action:${data.actionId}` : `case:${data.caseId}`)
        );
        const existing = Array.from(inMemoryReviews.values()).find(
          (r) => r.merchantId === mId && r.caseId === data.caseId && r.reviewKey === reviewKey,
        );
        if (existing) {
          return { created: false, review: existing };
        }
        const id = `rev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const review = {
          id,
          merchantId: mId,
          caseId: data.caseId,
          planVersionId: data.planVersionId || null,
          actionId: data.actionId || null,
          reviewKey,
          reasonForReview: data.reasonForReview,
          status: ReviewStatus.PENDING,
          reviewerId: null,
          reviewDecision: null,
          reviewNotes: null,
          revalidatedPolicyDecision: null,
          revalidatedAt: null,
          resolvedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        inMemoryReviews.set(id, review);
        return { created: true, review };
      }),
      getReviewById: vi.fn(async (mId: string, rId: string) => {
        const rev = inMemoryReviews.get(rId);
        if (!rev || rev.merchantId !== mId) return null;
        const caseRecord = inMemoryCases.get(rev.caseId);
        const planVersion = caseRecord?.planVersions?.find((pv: any) => pv.id === rev.planVersionId) || null;
        return {
          ...rev,
          case: caseRecord,
          planVersion,
          action: null,
          reviewer: null,
        };
      }),
      resolveReview: vi.fn(async (mId: string, rId: string, data: any) => {
        const rev = inMemoryReviews.get(rId);
        if (!rev || rev.merchantId !== mId) {
          throw new Error(`Human review "${rId}" not found for merchant "${mId}"`);
        }
        if (data.expectedStatus && rev.status !== data.expectedStatus) {
          throw new ReviewStateConflictError(rId, data.expectedStatus, rev.status);
        }
        const updated = {
          ...rev,
          reviewerId: data.reviewerId,
          status: data.status,
          reviewDecision: data.reviewDecision,
          reviewNotes: data.reviewNotes,
          revalidatedPolicyDecision: data.revalidatedPolicyDecision || null,
          revalidatedAt: data.revalidatedAt || null,
          resolvedAt: data.resolvedAt || new Date(),
          updatedAt: new Date(),
        };
        inMemoryReviews.set(rId, updated);
        return updated;
      }),
      listReviews: vi.fn(async (mId: string, filter?: any) => {
        return Array.from(inMemoryReviews.values())
          .filter((r) => r.merchantId === mId && (!filter?.status || r.status === filter.status));
      }),
      findPendingReviewForCase: vi.fn(async (mId: string, cId: string) => {
        return Array.from(inMemoryReviews.values())
          .find((r) => r.merchantId === mId && r.caseId === cId && r.status === ReviewStatus.PENDING) || null;
      }),
      findActiveTakeoverForCase: vi.fn(async (mId: string, cId: string) => {
        return Array.from(inMemoryReviews.values())
          .find((r) => r.merchantId === mId && r.caseId === cId && r.status === ReviewStatus.TAKEN_OVER) || null;
      }),
    };

    mockCaseRepo = {
      getCaseById: vi.fn(async (mId: string, cId: string) => {
        const c = inMemoryCases.get(cId);
        if (!c || c.merchantId !== mId) return null;
        return {
          ...c,
          customer: inMemoryCustomers.get(c.customerId),
        };
      }),
      compareAndSetStatus: vi.fn(async (mId: string, cId: string, expectedStatus: CaseStatus, targetStatus: CaseStatus) => {
        const c = inMemoryCases.get(cId);
        if (!c || c.merchantId !== mId) throw new Error('Case not found');
        if (c.status !== expectedStatus) {
          throw new Error(`Case state conflict: expected ${expectedStatus}, found ${c.status}`);
        }
        c.status = targetStatus;
        return c;
      }),
    };

    mockActionRepo = {
      createAction: vi.fn(async (_mId: string, cId: string, params: any) => {
        const id = `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const action = {
          id,
          caseId: cId,
          planVersionId: params.planVersionId || null,
          actionType: params.actionType,
          actionParams: params.actionParams,
          idempotencyKey: params.idempotencyKey,
          policyDecision: params.policyDecision,
          policyRationale: params.policyRationale,
          status: params.status || ActionExecutionStatus.PENDING,
          providerName: null,
          externalActionId: null,
          executionMetadata: params.executionMetadata || null,
          errorMessage: null,
          executedAt: null,
          createdAt: new Date(),
        };
        inMemoryActions.set(id, action);
        return action;
      }),
      getActionById: vi.fn(async (_mId: string, actId: string) => {
        return inMemoryActions.get(actId) || null;
      }),
      updateActionStatus: vi.fn(async (_mId: string, actId: string, data: any) => {
        const act = inMemoryActions.get(actId);
        if (!act) throw new Error('Action not found');
        act.status = data.status;
        if (data.providerName) act.providerName = data.providerName;
        if (data.externalActionId) act.externalActionId = data.externalActionId;
        if (data.executionMetadata) act.executionMetadata = data.executionMetadata;
        if (data.errorMessage) act.errorMessage = data.errorMessage;
        act.executedAt = new Date();
        return act;
      }),
      claimActionForExecution: vi.fn(async (_mId: string, aId: string) => {
        const action = inMemoryActions.get(aId);
        if (!action) return { claimed: false, action: null };
        if (action.status !== ActionExecutionStatus.PENDING) {
          return { claimed: false, action };
        }
        action.status = ActionExecutionStatus.EXECUTING;
        action.updatedAt = new Date();
        return { claimed: true, action };
      }),
      transitionActionStatus: vi.fn(
        async (_mId: string, aId: string, expectedStatus: ActionExecutionStatus, nextStatus: ActionExecutionStatus, extras?: any) => {
          const action = inMemoryActions.get(aId);
          if (!action) return { transitioned: false, action: null };
          if (action.status !== expectedStatus) return { transitioned: false, action };
          action.status = nextStatus;
          if (extras?.errorMessage) action.errorMessage = extras.errorMessage;
          action.updatedAt = new Date();
          return { transitioned: true, action };
        },
      ),
      bindApprovedReview: vi.fn(async (_mId: string, actId: string, rId: string) => {
        const action = inMemoryActions.get(actId);
        if (!action || action.status !== ActionExecutionStatus.PENDING) return null;
        action.policyDecision = PolicyDecision.ALLOW;
        action.executionMetadata = {
          executionSource: 'HUMAN_REVIEW_APPROVAL',
          reviewId: rId,
        };
        return action;
      }),
      hasCompletedSuccessfulAction: vi.fn(async () => false),
      findActionByIdempotencyKey: vi.fn(async () => null),
    };

    mockCustomerRepo = {
      getCustomerById: vi.fn(async (_mId: string, custId: string) => inMemoryCustomers.get(custId) || null),
      updateLastContactedAt: vi.fn(async (_mId: string, custId: string) => {
        const cust = inMemoryCustomers.get(custId);
        if (cust) cust.lastContactedAt = new Date();
      }),
    };

    mockMerchantRepo = {
      getMerchantById: vi.fn(async (mId: string) => inMemoryMerchants.get(mId) || null),
    };

    mockPolicyConfigRepo = {
      getOrCreateConfig: vi.fn(async () => ({
        maxRetriesPerCase: 3,
        maxContactsPerCase: 3,
        maxActionsPerCase: 5,
        cooldownHoursBetweenActions: 24,
        highValueThreshold: { toString: () => '50000.00' },
        minConfidenceThreshold: 0.7,
        reviewFirstMode: false,
        checkoutAbandonmentThresholdMinutes: 30,
        quietHoursStart: 22,
        quietHoursEnd: 8,
        quietHoursTimezone: 'Asia/Kolkata',
        maxRecoveryWindowDays: 14,
        overdueGracePeriodDays: 3,
      })),
    };

    mockCommitmentRepo = {
      getActiveCommitmentsForCase: vi.fn(async () => []),
    };

    mockOutcomeRepo = {
      listOutcomesByCase: vi.fn(async () => []),
    };

    mockAuditRepo = {
      record: vi.fn(async (_mId: string, entry: any) => {
        inMemoryAudits.push(entry);
        return { id: `aud_${Date.now()}`, ...entry, createdAt: new Date() };
      }),
    };

    policyEngine = new PolicyEngine();
    simulatedProvider = new SimulatedRecoveryProvider();
    providerRegistry = new ProviderRegistry();
    providerRegistry.registerProvider(simulatedProvider);

    actionExecutor = new ActionExecutor({
      actionRepo: mockActionRepo,
      caseRepo: mockCaseRepo,
      customerRepo: mockCustomerRepo,
      merchantRepo: mockMerchantRepo,
      humanReviewRepo: mockReviewRepo,
      auditRepo: mockAuditRepo,
      policyConfigRepo: mockPolicyConfigRepo,
      policyEngine,
      providerRegistry,
    });

    reviewService = new HumanReviewService({
      humanReviewRepo: mockReviewRepo,
      caseRepo: mockCaseRepo,
      actionRepo: mockActionRepo,
      customerRepo: mockCustomerRepo,
      merchantRepo: mockMerchantRepo,
      policyConfigRepo: mockPolicyConfigRepo,
      commitmentRepo: mockCommitmentRepo,
      outcomeRepo: mockOutcomeRepo,
      auditRepo: mockAuditRepo,
      policyEngine,
      actionExecutor,
    });
  });

  // A. Review Creation
  it('requests human review, updates case status to NEEDS_REVIEW, and audits REVIEW_REQUESTED', async () => {
    const caseRecord = inMemoryCases.get(caseId);
    caseRecord.status = CaseStatus.OPEN;

    const result = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'High-value customer escalation requiring human check',
    });

    expect(result.created).toBe(true);
    expect(result.caseStatus).toBe(CaseStatus.NEEDS_REVIEW);
    expect(result.review.status).toBe(ReviewStatus.PENDING);
    expect(result.review.planVersionId).toBe(planVersionId);

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      merchantId,
      expect.objectContaining({
        eventType: 'REVIEW_REQUESTED',
        reasonCode: 'HUMAN_REVIEW_REQUESTED',
      }),
    );
  });

  it('rejects review request on terminal case without creating review', async () => {
    const caseRecord = inMemoryCases.get(caseId);
    caseRecord.status = CaseStatus.RECOVERED;

    const result = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'Should not create',
    });

    expect(result.created).toBe(false);
    expect(result.review).toBeNull();
    expect(result.caseStatus).toBe(CaseStatus.RECOVERED);
    expect(mockReviewRepo.createReview).not.toHaveBeenCalled();
  });

  // B. Approval Happy Path
  it('approves review, passes fresh policy revalidation, executes action, and records audits', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs check',
    });

    const approval = await reviewService.approveReview(merchantId, review.id, reviewerId, {
      notes: 'Approved after verifying customer account',
    });

    expect(approval.approved).toBe(true);
    expect(approval.review?.status).toBe(ReviewStatus.APPROVED);
    expect(approval.error).toBeUndefined();
    expect(approval.executionResult?.success).toBe(true);
    expect(approval.action?.status).toBe(ActionExecutionStatus.SUCCESS);

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      merchantId,
      expect.objectContaining({
        eventType: 'REVIEW_APPROVED',
        actorType: AuditActorType.HUMAN,
      }),
    );
    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      merchantId,
      expect.objectContaining({
        eventType: 'REVIEW_EXECUTION_AUTHORIZED',
        actorType: AuditActorType.POLICY,
      }),
    );
  });

  // C. Hard Invariant Prevents Approval Override (Opt-Out & Kill Switch)
  it('blocks execution when customer opted out before approval with 0 provider calls', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs check',
    });

    // Customer opts out before human approves
    const customer = inMemoryCustomers.get(customerId);
    customer.optedOut = true;

    const approval = await reviewService.approveReview(merchantId, review.id, reviewerId);

    expect(approval.approved).toBe(false);
    expect(approval.blockedByPolicy).toBe(true);
    expect(approval.policyDecision).toBe(PolicyDecision.DENY);
    expect(approval.policyReasonCode).toBe('CUSTOMER_OPTED_OUT');
    expect(mockActionRepo.createAction).not.toHaveBeenCalled();

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      merchantId,
      expect.objectContaining({
        eventType: 'REVIEW_EXECUTION_BLOCKED',
        reasonCode: 'CUSTOMER_OPTED_OUT',
      }),
    );
  });

  it('blocks execution when kill switch is enabled before approval', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs check',
    });

    // Merchant activates kill switch
    const merchant = inMemoryMerchants.get(merchantId);
    merchant.killSwitchActive = true;

    const approval = await reviewService.approveReview(merchantId, review.id, reviewerId);

    expect(approval.approved).toBe(false);
    expect(approval.blockedByPolicy).toBe(true);
    expect(approval.policyReasonCode).toBe('KILL_SWITCH_ACTIVE');
    expect(mockActionRepo.createAction).not.toHaveBeenCalled();
  });

  // D. Stale Proposal Rejection
  it('fails safely with zero provider calls if case was replanned to a newer version', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId, // Bound to v1
      reasonForReview: 'Reviewing v1 proposal',
    });

    // Case was replanned to v2
    const caseRecord = inMemoryCases.get(caseId);
    const newPlanVersionId = 'pv_review_unit_02';
    caseRecord.planVersions.unshift({
      id: newPlanVersionId,
      version: 2,
      diagnosisCode: 'HARD_DECLINE',
      diagnosisSummary: 'Card expired',
      proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
      proposedActionParams: {},
      confidence: 0.95,
      createdAt: new Date(),
    });

    const approval = await reviewService.approveReview(merchantId, review.id, reviewerId);

    expect(approval.approved).toBe(false);
    expect(approval.stale).toBe(true);
    expect(mockActionRepo.createAction).not.toHaveBeenCalled();

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      merchantId,
      expect.objectContaining({
        eventType: 'REVIEW_STALE',
        reasonCode: 'STALE_PROPOSAL_SUPERSEDED',
      }),
    );
  });

  // E. Case Already Recovered / Stopped
  it('fails safely without executing if case was already recovered externally', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Check',
    });

    const caseRecord = inMemoryCases.get(caseId);
    caseRecord.status = CaseStatus.RECOVERED;

    const approval = await reviewService.approveReview(merchantId, review.id, reviewerId);

    expect(approval.approved).toBe(false);
    expect(approval.stale).toBe(true);
    expect(mockActionRepo.createAction).not.toHaveBeenCalled();

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      merchantId,
      expect.objectContaining({
        eventType: 'REVIEW_STALE',
        reasonCode: 'REVIEW_APPROVAL_REJECTED_TERMINAL',
      }),
    );
  });

  // F. Rejection Reopens Case
  it('rejects review, audits REVIEW_REJECTED, and transitions case NEEDS_REVIEW -> OPEN', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs human review',
    });

    const result = await reviewService.rejectReview(merchantId, review.id, reviewerId, {
      reason: 'Disapproved discount offering',
      notes: 'Customer tier too low for discounts',
    });

    expect(result.rejected).toBe(true);
    expect(result.review?.status).toBe(ReviewStatus.REJECTED);
    expect(mockCaseRepo.compareAndSetStatus).toHaveBeenCalledWith(
      merchantId,
      caseId,
      CaseStatus.NEEDS_REVIEW,
      CaseStatus.OPEN,
    );

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      merchantId,
      expect.objectContaining({
        eventType: 'REVIEW_REJECTED',
        actorType: AuditActorType.HUMAN,
      }),
    );
  });

  // G. Human Takeover
  it('marks review TAKEN_OVER, audits REVIEW_TAKEN_OVER, and preserves case state', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs VIP handling',
    });

    const result = await reviewService.takeOverReview(merchantId, review.id, reviewerId, {
      notes: 'Account manager handling manually via direct phone',
    });

    expect(result.takenOver).toBe(true);
    expect(result.review?.status).toBe(ReviewStatus.TAKEN_OVER);

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      merchantId,
      expect.objectContaining({
        eventType: 'REVIEW_TAKEN_OVER',
        actorType: AuditActorType.HUMAN,
      }),
    );
  });

  // H. Administrative Close
  it('closes review and stops case recovery when stopCase is true', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Closing review',
    });

    const result = await reviewService.closeReview(merchantId, review.id, reviewerId, {
      reason: 'Customer churned',
      stopCase: true,
    });

    expect(result.closed).toBe(true);
    expect(result.review?.status).toBe(ReviewStatus.CLOSED);
    expect(mockCaseRepo.compareAndSetStatus).toHaveBeenCalledWith(
      merchantId,
      caseId,
      CaseStatus.NEEDS_REVIEW,
      CaseStatus.STOPPED,
    );

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      merchantId,
      expect.objectContaining({
        eventType: 'REVIEW_CLOSED',
        actorType: AuditActorType.HUMAN,
      }),
    );
    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      merchantId,
      expect.objectContaining({
        eventType: 'STOP_RECOVERY',
        actorType: AuditActorType.HUMAN,
      }),
    );
  });
});
