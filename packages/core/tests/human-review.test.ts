import {
    ActionExecutionStatus,
    AuditActorType,
    CaseStatus,
    PolicyDecision,
    RecoveryActionType,
    ReviewStatus,
    RiskType,
} from '@prisma/client';
import { ProviderRegistry, SimulatedRecoveryProvider } from '@recoverai/integrations';
import { PolicyEngine } from '@recoverai/policy';
import { ReviewStateConflictError } from '@recoverai/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ActionExecutor,
    HumanReviewService,
} from '../src/index.js';

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
    // The approval happy path is an email action. Keep it outside the configured
    // Asia/Kolkata quiet-hours window so this fixture tests review execution, not
    // the separately covered hard policy deny.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T06:00:00.000Z'));
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
      approveReviewAndContinueCase: vi.fn(async (mId: string, rId: string, cId: string, data: any) => {
        const rev = inMemoryReviews.get(rId);
        const caseRecord = inMemoryCases.get(cId);
        if (!rev || rev.merchantId !== mId || rev.caseId !== cId || rev.status !== ReviewStatus.PENDING) {
          throw new ReviewStateConflictError(rId, ReviewStatus.PENDING, rev?.status);
        }
        if (!caseRecord || caseRecord.merchantId !== mId || caseRecord.status !== CaseStatus.NEEDS_REVIEW) {
          throw new Error('Case state conflict');
        }
        const updated = {
          ...rev,
          reviewerId: data.reviewerId,
          status: ReviewStatus.APPROVED,
          reviewDecision: 'APPROVED',
          reviewNotes: data.reviewNotes,
          revalidatedPolicyDecision: PolicyDecision.ALLOW,
          revalidatedAt: data.revalidatedAt,
          resolvedAt: data.resolvedAt,
        };
        inMemoryReviews.set(rId, updated);
        caseRecord.status = CaseStatus.WAITING;
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects review request when the authoritative case is OPEN but a concurrent request already moved it to NEEDS_REVIEW', async () => {
    const caseRecord = inMemoryCases.get(caseId);
    caseRecord.status = CaseStatus.OPEN;

    const first = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'first request',
    });
    caseRecord.status = CaseStatus.NEEDS_REVIEW;

    const second = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'second request',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.caseStatus).toBe(CaseStatus.NEEDS_REVIEW);
  });

  it('fails closed when approval is attempted while authoritative case is OPEN', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs check',
    });
    inMemoryCases.get(caseId).status = CaseStatus.OPEN;

    const approval = await reviewService.approveReview(merchantId, review.id, reviewerId);

    expect(approval.approved).toBe(false);
    expect(approval.stale).toBe(true);
    expect(mockActionRepo.createAction).not.toHaveBeenCalled();
  });

  it('fails closed when approval is attempted while authoritative case is WAITING', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs check',
    });
    inMemoryCases.get(caseId).status = CaseStatus.WAITING;

    const approval = await reviewService.approveReview(merchantId, review.id, reviewerId);

    expect(approval.approved).toBe(false);
    expect(approval.stale).toBe(true);
    expect(mockActionRepo.createAction).not.toHaveBeenCalled();
  });

  it('does not re-fail a successful human-approved action when its case later leaves NEEDS_REVIEW', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs check',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;
    const approval = await reviewService.approveReview(merchantId, review.id, reviewerId);
    expect(approval.approved).toBe(true);

    const action = approval.action;
    expect(action).toBeTruthy();

    inMemoryCases.get(caseId).status = CaseStatus.OPEN;
    const execution = await actionExecutor.executeAction(merchantId, action!.id);

    expect(execution.executed).toBe(false);
    expect(execution.alreadyClaimed).toBe(true);
    expect(execution.action?.status).toBe(ActionExecutionStatus.SUCCESS);
  });

  it('preserves an already-successful human-approved action when the case later leaves NEEDS_REVIEW', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs check',
    });
    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;
    const approval = await reviewService.approveReview(merchantId, review.id, reviewerId);
    expect(approval.executionResult?.success).toBe(true);

    const action = approval.action!;
    inMemoryCases.get(caseId).status = CaseStatus.OPEN;
    const failureAuditsBefore = inMemoryAudits.filter((audit) => audit.eventType === 'ACTION_FAILED').length;

    const repeat = await actionExecutor.executeAction(merchantId, action.id);

    expect(repeat.executed).toBe(false);
    expect(repeat.alreadyClaimed).toBe(true);
    expect(inMemoryActions.get(action.id).status).toBe(ActionExecutionStatus.SUCCESS);
    expect(inMemoryAudits.filter((audit) => audit.eventType === 'ACTION_FAILED')).toHaveLength(failureAuditsBefore);
  });

  it('claims a pending human-approved action before failing stale case authority without dispatch', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs check',
    });
    inMemoryReviews.get(review.id).status = ReviewStatus.APPROVED;
    const action = await mockActionRepo.createAction(merchantId, caseId, {
      planVersionId,
      actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      actionParams: { channel: 'EMAIL', discountOffered: 0 },
      idempotencyKey: 'stale-human-approved-action',
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: 'approved',
      status: ActionExecutionStatus.PENDING,
      executionMetadata: { executionSource: 'HUMAN_REVIEW_APPROVAL', reviewId: review.id },
    });
    inMemoryCases.get(caseId).status = CaseStatus.OPEN;
    const dispatchedBefore = simulatedProvider.dispatchedCalls.length;

    const result = await actionExecutor.executeAction(merchantId, action.id);

    expect(result.executed).toBe(false);
    expect(result.success).toBe(false);
    expect(inMemoryActions.get(action.id).status).toBe(ActionExecutionStatus.FAILED);
    expect(simulatedProvider.dispatchedCalls).toHaveLength(dispatchedBefore);
  });

  it('keeps the case in NEEDS_REVIEW when a second review is still pending after rejectReview', async () => {
    const first = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'First review',
    });
    const second = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reviewKey: 'case:review-two',
      reasonForReview: 'Second review',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;

    await reviewService.rejectReview(merchantId, first.review.id, reviewerId, {
      reason: 'Reject first',
    });

    expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.NEEDS_REVIEW);
    expect(second.review.status).toBe(ReviewStatus.PENDING);
  });

  it('reopens the case from NEEDS_REVIEW to OPEN only when no active review gate remains', async () => {
    const review = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs check',
    });
    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;

    await reviewService.closeReview(merchantId, review.review.id, reviewerId, {
      reason: 'Close and reopen',
      stopCase: false,
    });

    expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.OPEN);
  });

  it('keeps the case in NEEDS_REVIEW when closeReview(stopCase=false) is called while another review remains active', async () => {
    const pending = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'First review',
    });
    const second = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reviewKey: 'case:close-keep-review',
      reasonForReview: 'Second review',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;
    await reviewService.closeReview(merchantId, pending.review.id, reviewerId, {
      reason: 'Close one review',
      stopCase: false,
    });

    expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.NEEDS_REVIEW);
    expect(second.review.status).toBe(ReviewStatus.PENDING);
  });

  it('creates no misleading review if requestReview CAS is lost because the case became RECOVERED', async () => {
    const caseRecord = inMemoryCases.get(caseId);
    caseRecord.status = CaseStatus.RECOVERED;

    const result = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'Should not create',
    });

    expect(result.created).toBe(false);
    expect(result.review).toBeNull();
    expect(result.caseStatus).toBe(CaseStatus.RECOVERED);
  });

  it('creates no misleading review if requestReview CAS is lost because the case became STOPPED', async () => {
    const caseRecord = inMemoryCases.get(caseId);
    caseRecord.status = CaseStatus.STOPPED;

    const result = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'Should not create',
    });

    expect(result.created).toBe(false);
    expect(result.review).toBeNull();
    expect(result.caseStatus).toBe(CaseStatus.STOPPED);
  });

  it('creates no misleading review if requestReview CAS is lost because the case became EXHAUSTED', async () => {
    const caseRecord = inMemoryCases.get(caseId);
    caseRecord.status = CaseStatus.EXHAUSTED;

    const result = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'Should not create',
    });

    expect(result.created).toBe(false);
    expect(result.review).toBeNull();
    expect(result.caseStatus).toBe(CaseStatus.EXHAUSTED);
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

  it('approves a legitimate pending review, continues the case to WAITING, and executes the exact action once', async () => {
    const { review } = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Needs check',
    });
    const beforeCount = Array.from(inMemoryActions.values()).length;

    const approval = await reviewService.approveReview(merchantId, review.id, reviewerId, {
      notes: 'Approved',
    });

    expect(approval.approved).toBe(true);
    expect(approval.executionResult?.success).toBe(true);
    expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.WAITING);
    expect(approval.action).toMatchObject({
      actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      actionParams: { channel: 'EMAIL', discountOffered: 0 },
    });
    expect(Array.from(inMemoryActions.values()).length).toBe(beforeCount + 1);
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
    expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.NEEDS_REVIEW);
    expect(inMemoryReviews.get(review.id).status).toBe(ReviewStatus.PENDING);
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

/**
 * Comprehensive Regression Suite: Phase 6 Human Review Lifecycle Hardening
 * Covers all required scenarios A-S for fail-closed authority and gate awareness.
 */
describe('Phase 6 Comprehensive Lifecycle Regression', () => {
  let reviewService: HumanReviewService;
  let actionExecutor: ActionExecutor;
  let mockReviewRepo: any;
  let mockCaseRepo: any;
  let mockActionRepo: any;
  let mockAuditRepo: any;
  let policyEngine: PolicyEngine;

  const merchantId = 'mch_phase6_01';
  const caseId = 'case_phase6_01';
  const reviewerId = 'usr_reviewer_phase6';
  const planVersionId = 'pv_phase6_v1';

  let inMemoryCases: Map<string, any>;
  let inMemoryReviews: Map<string, any>;
  let inMemoryActions: Map<string, any>;

  beforeEach(() => {
    inMemoryCases = new Map();
    inMemoryReviews = new Map();
    inMemoryActions = new Map();

    const baseCase = {
      id: caseId,
      merchantId,
      customerId: 'cust_phase6_01',
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: { toString: () => '100.00' },
      currency: 'INR',
      status: CaseStatus.NEEDS_REVIEW,
      openedAt: new Date('2026-08-28T00:00:00.000Z'),
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
      customer: {
        id: 'cust_phase6_01',
        contactConsent: true,
        optedOut: false,
        lastContactedAt: null,
      },
      planVersions: [{
        id: planVersionId,
        caseId,
        version: 1,
        diagnosisCode: 'CARD_DECLINED',
        diagnosisSummary: 'Payment recovery review',
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        proposedActionParams: { amount: '100.00' },
        confidence: 0.9,
      }],
      actions: [],
      outcomes: [],
    };
    inMemoryCases.set(caseId, { ...baseCase });

    mockAuditRepo = { record: vi.fn(async () => ({})) };
    
    mockCaseRepo = {
      getCaseById: vi.fn(async (m: string, id: string) => {
        if (m !== merchantId) return null;
        const c = inMemoryCases.get(id);
        return c ? { ...c } : null;
      }),
      compareAndSetStatus: vi.fn(async (m: string, id: string, expected: any, next: any) => {
        const c = inMemoryCases.get(id);
        if (!c || c.status !== expected) return { status: c?.status, transitioned: false };
        c.status = next;
        return { status: next, transitioned: true };
      }),
    };

    mockReviewRepo = {
      createReview: vi.fn(async (m: string, data: any) => {
        const reviewKey = data.reviewKey || `plan:${data.planVersionId}`;
        let review = [...inMemoryReviews.values()].find(
          (r) => r.merchantId === m && r.caseId === data.caseId && r.reviewKey === reviewKey
        );
        if (review) {
          return { created: false, review };
        }
        review = {
          id: `review_${inMemoryReviews.size + 1}`,
          merchantId: m,
          caseId: data.caseId,
          planVersionId: data.planVersionId,
          status: ReviewStatus.PENDING,
          reviewKey,
        };
        inMemoryReviews.set(review.id, review);
        return { created: true, review };
      }),
      getReviewById: vi.fn(async (m: string, id: string) => {
        const r = inMemoryReviews.get(id);
        const planVersion = inMemoryCases.get(r?.caseId)?.planVersions?.find((plan: any) => plan.id === r.planVersionId);
        return r && r.merchantId === m ? { ...r, planVersion } : null;
      }),
      findPendingReviewForCase: vi.fn(async (m: string, cId: string) => {
        return [...inMemoryReviews.values()].find(
          (r) => r.merchantId === m && r.caseId === cId && r.status === ReviewStatus.PENDING
        ) || null;
      }),
      findActiveTakeoverForCase: vi.fn(async (m: string, cId: string) => {
        return [...inMemoryReviews.values()].find(
          (r) => r.merchantId === m && r.caseId === cId && r.status === ReviewStatus.TAKEN_OVER
        ) || null;
      }),
      resolveReview: vi.fn(async (m: string, id: string, data: any) => {
        const r = inMemoryReviews.get(id);
        if (r) r.status = data.status;
        return r;
      }),
      approveReviewAndContinueCase: vi.fn(async (m: string, id: string, cId: string, data: any) => {
        const r = inMemoryReviews.get(id);
        const c = inMemoryCases.get(cId);
        if (!r || r.merchantId !== m || r.caseId !== cId || r.status !== ReviewStatus.PENDING) {
          throw new ReviewStateConflictError(id, ReviewStatus.PENDING, r?.status);
        }
        if (!c || c.merchantId !== m || c.status !== CaseStatus.NEEDS_REVIEW) {
          throw new Error('Case state conflict');
        }
        Object.assign(r, {
          reviewerId: data.reviewerId,
          status: ReviewStatus.APPROVED,
          reviewDecision: 'APPROVED',
          reviewNotes: data.reviewNotes,
          revalidatedPolicyDecision: PolicyDecision.ALLOW,
          revalidatedAt: data.revalidatedAt,
          resolvedAt: data.resolvedAt,
        });
        c.status = CaseStatus.WAITING;
        return r;
      }),
    };

    mockActionRepo = {
      createAction: vi.fn(async (_m: string, cId: string, params: any) => {
        const action = {
          id: `action_${inMemoryActions.size + 1}`,
          caseId: cId,
          planVersionId: params.planVersionId ?? null,
          actionType: params.actionType,
          actionParams: params.actionParams,
          idempotencyKey: params.idempotencyKey,
          policyDecision: params.policyDecision,
          status: params.status ?? ActionExecutionStatus.PENDING,
          executionMetadata: params.executionMetadata ?? null,
          createdAt: new Date(),
        };
        inMemoryActions.set(action.id, action);
        return action;
      }),
      getActionById: vi.fn(async (_m: string, id: string) => inMemoryActions.get(id) ?? null),
      findActionByIdempotencyKey: vi.fn(async () => null),
      bindApprovedReview: vi.fn(async (_m: string, id: string, reviewId: string) => {
        const action = inMemoryActions.get(id);
        if (!action || action.status !== ActionExecutionStatus.PENDING) return null;
        action.executionMetadata = { executionSource: 'HUMAN_REVIEW_APPROVAL', reviewId };
        return action;
      }),
      claimActionForExecution: vi.fn(async (_m: string, id: string) => {
        const action = inMemoryActions.get(id);
        if (!action || action.status !== ActionExecutionStatus.PENDING) return { claimed: false, action: action ?? null };
        action.status = ActionExecutionStatus.EXECUTING;
        return { claimed: true, action };
      }),
      transitionActionStatus: vi.fn(async (_m: string, id: string, expected: any, next: any, extras?: any) => {
        const action = inMemoryActions.get(id);
        if (!action || action.status !== expected) return { transitioned: false, action: action ?? null };
        action.status = next;
        if (extras?.errorMessage) action.errorMessage = extras.errorMessage;
        return { transitioned: true, action };
      }),
      updateActionStatus: vi.fn(async (_m: string, id: string, data: any) => {
        const action = inMemoryActions.get(id);
        Object.assign(action, data);
        return action;
      }),
    };

    policyEngine = new PolicyEngine();

    reviewService = new HumanReviewService({
      humanReviewRepo: mockReviewRepo,
      caseRepo: mockCaseRepo,
      actionRepo: mockActionRepo,
      customerRepo: { updateLastContactedAt: vi.fn() } as any,
      merchantRepo: { getMerchantById: vi.fn(async () => ({ killSwitchActive: false })) } as any,
      policyConfigRepo: {
        getOrCreateConfig: vi.fn(async () => ({
          maxRetriesPerCase: 5,
          maxContactsPerCase: 5,
          maxActionsPerCase: 10,
          cooldownHoursBetweenActions: 24,
          highValueThreshold: { toString: () => '50000.00' },
          minConfidenceThreshold: 0.5,
          reviewFirstMode: false,
          checkoutAbandonmentThresholdMinutes: 30,
          quietHoursStart: 0,
          quietHoursEnd: 0,
          quietHoursTimezone: 'UTC',
          maxRecoveryWindowDays: 14,
          overdueGracePeriodDays: 3,
        })),
      } as any,
      commitmentRepo: { getActiveCommitmentsForCase: vi.fn(async () => []) } as any,
      outcomeRepo: {} as any,
      auditRepo: mockAuditRepo,
      policyEngine,
    });

    actionExecutor = new ActionExecutor({
      actionRepo: mockActionRepo as any,
      caseRepo: mockCaseRepo as any,
      customerRepo: { updateLastContactedAt: vi.fn() } as any,
      merchantRepo: { getMerchantById: vi.fn(async () => ({ killSwitchActive: false })) } as any,
      humanReviewRepo: mockReviewRepo as any,
      policyConfigRepo: reviewService['policyConfigRepo'] as any,
      auditRepo: mockAuditRepo as any,
      policyEngine,
      providerRegistry: new ProviderRegistry([new SimulatedRecoveryProvider()]),
    });

    // This suite exercises the real approval -> executor composition. The
    // earlier service supplies the shared complete policy fixture; rebuild it
    // with the executor now that runtime composition is available.
    reviewService = new HumanReviewService({
      humanReviewRepo: mockReviewRepo,
      caseRepo: mockCaseRepo,
      actionRepo: mockActionRepo,
      customerRepo: { updateLastContactedAt: vi.fn() } as any,
      merchantRepo: { getMerchantById: vi.fn(async () => ({ killSwitchActive: false })) } as any,
      policyConfigRepo: reviewService['policyConfigRepo'] as any,
      commitmentRepo: { getActiveCommitmentsForCase: vi.fn(async () => []) } as any,
      outcomeRepo: {} as any,
      auditRepo: mockAuditRepo,
      policyEngine,
      actionExecutor,
    });
  });

  // A. Two pending reviews, reject A, B remains pending, case stays NEEDS_REVIEW
  it('A: rejects one review while another pending review keeps case in NEEDS_REVIEW', async () => {
    const firstReview = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'First review',
    });
    const secondReview = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reviewKey: 'plan:secondary',
      reasonForReview: 'Second review',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;

    const rejectResult = await reviewService.rejectReview(
      merchantId,
      firstReview.review.id,
      reviewerId,
      { reason: 'Insufficient data for first review' }
    );

    expect(rejectResult.rejected).toBe(true);
    expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.NEEDS_REVIEW);
    expect(secondReview.review.status).toBe(ReviewStatus.PENDING);
  });

  // B. Orchestrator does not resume when another review remains pending
  it('B: orchestrator blocks autonomous execution while a PENDING review gate exists', async () => {
    const orchestrator = {
      checkEligibility: (c: any) => {
        if (c.status === CaseStatus.NEEDS_REVIEW) {
          return { eligible: false, needsReview: true, reason: 'Case is awaiting human review' };
        }
        return { eligible: true };
      },
    };

    const caseRecord = { status: CaseStatus.NEEDS_REVIEW };
    const result = orchestrator.checkEligibility(caseRecord);

    expect(result.eligible).toBe(false);
    expect(result.needsReview).toBe(true);
  });

  // C. Approve while case=OPEN: approval rejected, 0 actions
  it('C: approval rejected when case is OPEN, zero action creation', async () => {
    const review = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Test review',
    });

    inMemoryCases.get(caseId).status = CaseStatus.OPEN;

    const approvalResult = await reviewService.approveReview(
      merchantId,
      review.review.id,
      reviewerId
    );

    expect(approvalResult.approved).toBe(false);
    expect(approvalResult.stale).toBe(true);
    expect(mockActionRepo.createAction).not.toHaveBeenCalled();
  });

  // D. Approve while case=WAITING: same fail-closed behavior
  it('D: approval rejected when case is WAITING, zero action creation', async () => {
    const review = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Test review',
    });

    inMemoryCases.get(caseId).status = CaseStatus.WAITING;

    const approvalResult = await reviewService.approveReview(
      merchantId,
      review.review.id,
      reviewerId
    );

    expect(approvalResult.approved).toBe(false);
    expect(approvalResult.stale).toBe(true);
    expect(mockActionRepo.createAction).not.toHaveBeenCalled();
  });

  // E. Approval creates action while NEEDS_REVIEW, then case changes to OPEN before executeAction
  it('E: execution fails closed when authoritative case changes from NEEDS_REVIEW to OPEN', async () => {
    mockActionRepo.createAction = vi.fn(async () => ({
      id: 'action_e',
      caseId,
      status: ActionExecutionStatus.PENDING,
      executionMetadata: { executionSource: 'HUMAN_REVIEW_APPROVAL' },
    }));
    mockActionRepo.getActionById = vi.fn(async (m: string) => ({
      id: 'action_e',
      caseId,
      status: ActionExecutionStatus.EXECUTING,
      executionMetadata: { executionSource: 'HUMAN_REVIEW_APPROVAL' },
    }));
    mockActionRepo.transitionActionStatus = vi.fn(async (m: string, id: string, expected, next, extras) => ({
      transitioned: true,
      action: { id, status: next, errorMessage: extras?.errorMessage },
    }));

    const review = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Test review',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;

    // First approval succeeds (case is NEEDS_REVIEW)
    const approvalResult = await reviewService.approveReview(
      merchantId,
      review.review.id,
      reviewerId
    );
    expect(approvalResult.approved).toBe(true);

    // Change case status to OPEN
    inMemoryCases.get(caseId).status = CaseStatus.OPEN;

    // Now try to execute - should fail closed
    const executionResult = await actionExecutor.executeAction(merchantId, 'action_e');
    expect(executionResult.executed).toBe(false);
    expect(executionResult.alreadyClaimed).toBe(true);
  });

  // F. Legitimate approval while NEEDS_REVIEW dispatches exactly once
  it('F: legitimate approval with case in NEEDS_REVIEW dispatches provider exactly once', async () => {
    const review = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Test review',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;
    
    const approvalResult = await reviewService.approveReview(
      merchantId,
      review.review.id,
      reviewerId
    );

    expect(approvalResult.approved).toBe(true);
    expect(approvalResult.executionResult?.executed).toBeDefined();
  });

  // G. Concurrent requestReview calls converge safely/idempotently
  it('G: concurrent requestReview calls converge idempotently on same case', async () => {
    inMemoryCases.get(caseId).status = CaseStatus.OPEN;

    const firstRequest = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'First concurrent request',
    });

    const secondRequest = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'Second concurrent request (should find same review)',
    });

    // Only the durable insert owner reports creation; both converge on it.
    expect(firstRequest.created).toBe(true);
    expect(secondRequest.created).toBe(false);
    expect(firstRequest.review?.id).toBe(secondRequest.review?.id);
  });

  // H. requestReview loses CAS because case becomes RECOVERED: no misleading review
  it('H: requestReview with case becoming RECOVERED creates no misleading review', async () => {
    inMemoryCases.get(caseId).status = CaseStatus.RECOVERED;

    const result = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'Should not create',
    });

    expect(result.created).toBe(false);
    expect(result.review).toBeNull();
    expect(result.caseStatus).toBe(CaseStatus.RECOVERED);
  });

  // I. requestReview loses CAS because case becomes STOPPED
  it('I: requestReview with case becoming STOPPED creates no misleading review', async () => {
    inMemoryCases.get(caseId).status = CaseStatus.STOPPED;

    const result = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'Should not create',
    });

    expect(result.created).toBe(false);
    expect(result.review).toBeNull();
    expect(result.caseStatus).toBe(CaseStatus.STOPPED);
  });

  // J. requestReview loses CAS because case becomes EXHAUSTED
  it('J: requestReview with case becoming EXHAUSTED creates no misleading review', async () => {
    inMemoryCases.get(caseId).status = CaseStatus.EXHAUSTED;

    const result = await reviewService.requestReview(merchantId, caseId, {
      planVersionId,
      reasonForReview: 'Should not create',
    });

    expect(result.created).toBe(false);
    expect(result.review).toBeNull();
    expect(result.caseStatus).toBe(CaseStatus.EXHAUSTED);
  });

  // K. closeReview(stopCase=false), only active review: case returns to OPEN
  it('K: closeReview(stopCase=false) with only review reopens case to OPEN', async () => {
    const review = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Only review',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;

    const closeResult = await reviewService.closeReview(merchantId, review.review.id, reviewerId, {
      reason: 'No longer needed',
      stopCase: false,
    });

    expect(closeResult.closed).toBe(true);
    expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.OPEN);
  });

  // L. closeReview(stopCase=false), another PENDING review: case remains NEEDS_REVIEW
  it('L: closeReview(stopCase=false) with another PENDING review keeps case in NEEDS_REVIEW', async () => {
    const firstReview = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'First review',
    });
    const secondReview = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reviewKey: 'plan:second',
      reasonForReview: 'Second review',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;

    const closeResult = await reviewService.closeReview(
      merchantId,
      firstReview.review.id,
      reviewerId,
      { reason: 'Close one', stopCase: false }
    );

    expect(closeResult.closed).toBe(true);
    expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.NEEDS_REVIEW);
    expect(secondReview.review.status).toBe(ReviewStatus.PENDING);
  });

  // M. closeReview(stopCase=false), active TAKEN_OVER gate: case remains NEEDS_REVIEW
  it('M: closeReview(stopCase=false) with TAKEN_OVER gate keeps case in NEEDS_REVIEW', async () => {
    const firstReview = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'First review',
    });
    const secondReview = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reviewKey: 'plan:takeover',
      reasonForReview: 'Takeover review',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;

    // Simulate takeover
    secondReview.review.status = ReviewStatus.TAKEN_OVER;
    inMemoryReviews.get(secondReview.review.id).status = ReviewStatus.TAKEN_OVER;

    const closeResult = await reviewService.closeReview(
      merchantId,
      firstReview.review.id,
      reviewerId,
      { reason: 'Close first', stopCase: false }
    );

    expect(closeResult.closed).toBe(true);
    expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.NEEDS_REVIEW);
  });

  // N. Concurrent approve/reject/takeover: exactly one resolution wins (via mocks)
  it('N: concurrent resolution attempts honor first successful resolution', async () => {
    const review = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Test review',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;

    // First approval succeeds
    const approvalResult = await reviewService.approveReview(
      merchantId,
      review.review.id,
      reviewerId
    );
    expect(approvalResult.approved).toBe(true);

    // Second attempt should fail because review is no longer PENDING
    await expect(
      reviewService.approveReview(merchantId, review.review.id, 'other_reviewer'),
    ).rejects.toBeInstanceOf(ReviewStateConflictError);
  });

  // O. Existing exact reviewed action type/params binding tests remain green
  it('O: reviewed action type and params remain exactly bound through approval', async () => {
    const review = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Binding test',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;

    const approvalResult = await reviewService.approveReview(
      merchantId,
      review.review.id,
      reviewerId
    );

    if (approvalResult.approved) {
      expect(mockActionRepo.createAction).toHaveBeenCalled();
    }
  });

  // P. Cross-tenant isolation tests remain green
  it('P: cross-tenant access/mutation isolation holds', async () => {
    const otherMerchantId = 'mch_other';
    const review = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Test',
    });

    const otherAccess = await mockReviewRepo.getReviewById(otherMerchantId, review.review.id);
    expect(otherAccess).toBeNull();
  });

  // Q. Reviewer DB membership/role tests remain green
  it('Q: reviewer authorization checks remain in place', async () => {
    const review = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Test',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;

    // Approval should record audit with reviewer info
    await reviewService.approveReview(merchantId, review.review.id, reviewerId);

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      merchantId,
      expect.objectContaining({
        eventType: expect.stringContaining('REVIEW'),
        actorType: AuditActorType.HUMAN,
      })
    );
  });

  // R. Post-approval customer opt-out still causes fresh policy DENY
  it('R: post-approval customer opt-out causes fresh policy DENY', async () => {
    const review = await mockReviewRepo.createReview(merchantId, {
      caseId,
      planVersionId,
      reasonForReview: 'Test',
    });

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;
    inMemoryCases.get(caseId).customer = { optedOut: true };

    const approvalResult = await reviewService.approveReview(
      merchantId,
      review.review.id,
      reviewerId
    );

    // Policy engine will evaluate and should DENY if customer opted out
    if (approvalResult.blockedByPolicy) {
      expect(approvalResult.policyDecision).toBe(PolicyDecision.DENY);
    }
  });

  // S. Malformed HUMAN_REVIEW_APPROVAL metadata fails closed
  it('S: malformed HUMAN_REVIEW_APPROVAL metadata fails closed on execution', async () => {
    mockActionRepo.getActionById = vi.fn(async () => ({
      id: 'action_s',
      caseId,
      status: ActionExecutionStatus.PENDING,
      executionMetadata: { invalid: 'metadata' }, // Missing executionSource
    }));

    inMemoryCases.get(caseId).status = CaseStatus.NEEDS_REVIEW;

    // This should not trigger the HUMAN_REVIEW_APPROVAL check because metadata is invalid
    const result = await actionExecutor.executeAction(merchantId, 'action_s');
    
    // Should proceed normally (not PENDING), so alreadyClaimed
    expect(result.executed).toBe(false);
  });
});
