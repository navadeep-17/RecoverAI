import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma, ReviewStatus, Role } from '@prisma/client';
import {
  prisma,
  checkDatabaseConnection,
  ActionRepository,
  CaseRepository,
  MerchantRepository,
  CustomerRepository,
  AuditRepository,
  PolicyConfigRepository,
  CommitmentRepository,
  OutcomeRepository,
  HumanReviewRepository,
  TriggerRepository,
  CaseStatus,
  PolicyDecision,
  RecoveryActionType,
  RiskType,
  AuditActorType,
  ActionExecutionStatus,
} from '../src/index.js';
import {
  ActionExecutor,
  HumanReviewService,
  RecoveryOrchestrator,
  RecoveryAgent,
  MockLLMProvider,
} from '@recoverai/core';
import { PolicyEngine } from '@recoverai/policy';
import { ProviderRegistry, SimulatedRecoveryProvider } from '@recoverai/integrations';
import { ReviewStateConflictError, UnauthorizedReviewerError } from '@recoverai/shared';

describe('Human Review Workflow PostgreSQL Integration Tests', () => {
  let dbAvailable = false;
  let actionRepo: ActionRepository;
  let caseRepo: CaseRepository;
  let merchantRepo: MerchantRepository;
  let customerRepo: CustomerRepository;
  let auditRepo: AuditRepository;
  let policyConfigRepo: PolicyConfigRepository;
  let commitmentRepo: CommitmentRepository;
  let outcomeRepo: OutcomeRepository;
  let reviewRepo: HumanReviewRepository;
  let triggerRepo: TriggerRepository;
  let policyEngine: PolicyEngine;
  let simulatedProvider: SimulatedRecoveryProvider;
  let providerRegistry: ProviderRegistry;
  let actionExecutor: ActionExecutor;
  let reviewService: HumanReviewService;
  let mockLLM: MockLLMProvider;
  let recoveryAgent: RecoveryAgent;
  let orchestrator: RecoveryOrchestrator;

  const merchantAId = 'mch_rev_integ_a_01';
  const merchantBId = 'mch_rev_integ_b_02';

  const userAdminAId = 'usr_rev_admin_a_01';
  const userReviewerAId = 'usr_rev_reviewer_a_02';
  const userAdminBId = 'usr_rev_admin_b_01';
  const nonExistentUserId = 'usr_rev_unknown_99';
  const testClock = () => new Date('2026-08-28T14:00:00+05:30');

  beforeAll(async () => {
    try {
      dbAvailable = await checkDatabaseConnection();
      if (!dbAvailable) return;

      actionRepo = new ActionRepository();
      caseRepo = new CaseRepository();
      merchantRepo = new MerchantRepository();
      customerRepo = new CustomerRepository();
      auditRepo = new AuditRepository();
      policyConfigRepo = new PolicyConfigRepository();
      commitmentRepo = new CommitmentRepository();
      outcomeRepo = new OutcomeRepository();
      reviewRepo = new HumanReviewRepository();
      triggerRepo = new TriggerRepository();

      policyEngine = new PolicyEngine();
      simulatedProvider = new SimulatedRecoveryProvider();
      providerRegistry = new ProviderRegistry([simulatedProvider]);
      mockLLM = new MockLLMProvider();
      recoveryAgent = new RecoveryAgent(mockLLM);

      actionExecutor = new ActionExecutor({
        actionRepo,
        caseRepo,
        customerRepo,
        merchantRepo,
        humanReviewRepo: reviewRepo,
        auditRepo,
        policyConfigRepo,
        commitmentRepo,
        policyEngine,
        providerRegistry,
        clock: testClock,
      });

      reviewService = new HumanReviewService({
        humanReviewRepo: reviewRepo,
        caseRepo,
        actionRepo,
        customerRepo,
        merchantRepo,
        policyConfigRepo,
        commitmentRepo,
        outcomeRepo,
        auditRepo,
        policyEngine,
        actionExecutor,
        clock: testClock,
      });

      orchestrator = new RecoveryOrchestrator({
        caseRepo,
        actionRepo,
        customerRepo,
        merchantRepo,
        policyConfigRepo,
        commitmentRepo,
        auditRepo,
        humanReviewRepo: reviewRepo,
        recoveryAgent,
        policyEngine,
        actionExecutor,
        triggerRepo,
      });

      // Clean up previous test runs
      await prisma.merchant.deleteMany({
        where: { id: { in: [merchantAId, merchantBId] } },
      });

      // Create merchants
      await merchantRepo.create({
        id: merchantAId,
        name: 'Merchant A (Review Tests)',
        slug: `merchant-a-rev-${Date.now()}`,
      });

      await merchantRepo.create({
        id: merchantBId,
        name: 'Merchant B (Review Tests)',
        slug: `merchant-b-rev-${Date.now()}`,
      });

      // Create users with distinct roles
      await prisma.user.createMany({
        data: [
          {
            id: userAdminAId,
            merchantId: merchantAId,
            email: `admin-a-${Date.now()}@example.com`,
            name: 'Admin A',
            role: Role.MERCHANT_ADMIN,
            passwordHash: 'hash_a_admin',
          },
          {
            id: userReviewerAId,
            merchantId: merchantAId,
            email: `reviewer-a-${Date.now()}@example.com`,
            name: 'Reviewer A',
            role: Role.REVIEWER,
            passwordHash: 'hash_a_reviewer',
          },
          {
            id: userAdminBId,
            merchantId: merchantBId,
            email: `admin-b-${Date.now()}@example.com`,
            name: 'Admin B',
            role: Role.MERCHANT_ADMIN,
            passwordHash: 'hash_b_admin',
          },
        ],
      });

      // Initialize policy config
      await policyConfigRepo.getOrCreateConfig(merchantAId);
      await policyConfigRepo.getOrCreateConfig(merchantBId);
    } catch {
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    if (simulatedProvider) {
      simulatedProvider.dispatchedCalls = [];
      simulatedProvider.setBehavior(null);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.merchant.deleteMany({
        where: { id: { in: [merchantAId, merchantBId] } },
      });
      await prisma.$disconnect();
    }
  });

  // Helper to create customer and case in DB
  async function createTestCase(mId: string, overrides: Partial<Prisma.RevenueRiskCaseCreateInput> = {}) {
    const customer = await customerRepo.getOrCreateCustomer(mId, {
      externalCustomerId: `cust_ext_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: 'Integration Customer',
      email: `cust_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@example.com`,
      phone: '+919876543210',
      contactConsent: true,
    });

    const c = await caseRepo.createCase(mId, {
      customerId: customer.id,
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '2500.00',
      currency: 'INR',
      initialStatus: CaseStatus.OPEN,
      incidentKey: `inc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
    });

    const planVersion = await prisma.recoveryPlanVersion.create({
      data: {
        caseId: c.id,
        version: 1,
        diagnosisCode: 'CARD_DECLINED',
        diagnosisSummary: 'Card temporarily declined',
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        proposedActionParams: { channel: 'EMAIL', discountOffered: 0 },
        confidence: 0.85,
        reasoningSummary: 'Verified case facts support payment-link recovery; human review required before execution.',
      },
    });

    return { customer, testCase: c, planVersion };
  }

  // A. Review Creation & DB Idempotency
  it('Scenario A: PolicyDecision.REVIEW triggers HumanReview creation with status PENDING, case to NEEDS_REVIEW, and audit REVIEW_REQUESTED', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);

    const result = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'High-value customer escalation requiring human check',
    });

    expect(result.created).toBe(true);
    expect(result.review).toBeDefined();
    expect(result.review?.status).toBe(ReviewStatus.PENDING);
    expect(result.review?.planVersionId).toBe(planVersion.id);

    // Verify DB case status
    const updatedCase = await caseRepo.getCaseById(merchantAId, testCase.id);
    expect(updatedCase?.status).toBe(CaseStatus.NEEDS_REVIEW);

    // Verify audit record
    const audits = await auditRepo.listByCase(merchantAId, testCase.id);
    const reviewAudit = audits.find((a) => a.eventType === 'REVIEW_REQUESTED');
    expect(reviewAudit).toBeDefined();
  });

  // A2. 5-Way Concurrent DB Creation Proof
  it('Scenario A2: 5 simultaneous requestReview calls converge on same review, 1 DB record, 1 audit, case in NEEDS_REVIEW', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);

    // Run 5 simultaneous review requests for the same merchant/case/planVersion
    const results = await Promise.all([
      reviewService.requestReview(merchantAId, testCase.id, {
        planVersionId: planVersion.id,
        reasonForReview: 'Concurrent request 1',
      }),
      reviewService.requestReview(merchantAId, testCase.id, {
        planVersionId: planVersion.id,
        reasonForReview: 'Concurrent request 2',
      }),
      reviewService.requestReview(merchantAId, testCase.id, {
        planVersionId: planVersion.id,
        reasonForReview: 'Concurrent request 3',
      }),
      reviewService.requestReview(merchantAId, testCase.id, {
        planVersionId: planVersion.id,
        reasonForReview: 'Concurrent request 4',
      }),
      reviewService.requestReview(merchantAId, testCase.id, {
        planVersionId: planVersion.id,
        reasonForReview: 'Concurrent request 5',
      }),
    ]);

    // All 5 fulfilled
    expect(results).toHaveLength(5);
    const firstReviewId = results[0].review.id;

    // All 5 converge on the exact same review.id
    for (const res of results) {
      expect(res.review.id).toBe(firstReviewId);
      expect(res.review.status).toBe(ReviewStatus.PENDING);
    }

    // Exactly 1 review record in DB for this planVersion
    const dbReviews = await prisma.humanReview.findMany({
      where: { merchantId: merchantAId, caseId: testCase.id, planVersionId: planVersion.id },
    });
    expect(dbReviews).toHaveLength(1);
    expect(dbReviews[0].id).toBe(firstReviewId);

    // Exactly 1 REVIEW_REQUESTED audit recorded for this case
    const audits = await auditRepo.listByCase(merchantAId, testCase.id);
    const reviewAudits = audits.filter((a) => a.eventType === 'REVIEW_REQUESTED');
    expect(reviewAudits).toHaveLength(1);

    // Case is in NEEDS_REVIEW
    const updatedCase = await caseRepo.getCaseById(merchantAId, testCase.id);
    expect(updatedCase?.status).toBe(CaseStatus.NEEDS_REVIEW);

    // Also prove a different planVersionId creates a distinct review
    const planVersion2 = await prisma.recoveryPlanVersion.create({
      data: {
        caseId: testCase.id,
        version: 2,
        diagnosisCode: 'HARD_DECLINE',
        diagnosisSummary: 'Card expired',
        reasoningSummary: 'Version 2 plan requires elevated review due to card expiration.',
        proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        proposedActionParams: {},
        confidence: 0.9,
      },
    });

    const v2Result = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion2.id,
      reasonForReview: 'Distinct v2 review',
    });

    expect(v2Result.created).toBe(true);
    expect(v2Result.review.id).not.toBe(firstReviewId);
    expect(v2Result.review.planVersionId).toBe(planVersion2.id);
  });

  it('Scenario A3: concurrent close and a new review request never leave a pending review case OPEN', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);
    const first = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'First review to close',
    });

    const [, second] = await Promise.all([
      reviewService.closeReview(merchantAId, first.review!.id, userReviewerAId, {
        reason: 'Close concurrently',
        stopCase: false,
      }),
      reviewService.requestReview(merchantAId, testCase.id, {
        reviewKey: `concurrent:${planVersion.id}`,
        planVersionId: planVersion.id,
        reasonForReview: 'New active review gate',
      }),
    ]);

    expect(second.review?.status).toBe(ReviewStatus.PENDING);
    const finalCase = await caseRepo.getCaseById(merchantAId, testCase.id);
    expect(finalCase?.status).toBe(CaseStatus.NEEDS_REVIEW);
  });

  it('Scenario A4: terminal transition winning the post-create repair closes the new review gate', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);
    let caseReads = 0;
    const racingCaseRepo = new Proxy(caseRepo, {
      get(target, property, receiver) {
        if (property !== 'getCaseById') {
          return Reflect.get(target, property, receiver);
        }
        return async (merchantId: string, caseId: string) => {
          caseReads += 1;
          const current = await target.getCaseById(merchantId, caseId);
          if (caseReads === 2 && current?.status === CaseStatus.NEEDS_REVIEW) {
            // Simulate a terminal worker winning between the post-create read
            // and the OPEN/WAITING -> NEEDS_REVIEW repair CAS.
            await target.compareAndSetStatus(
              merchantId,
              caseId,
              CaseStatus.NEEDS_REVIEW,
              CaseStatus.RECOVERED,
            );
            return { ...current, status: CaseStatus.OPEN };
          }
          return current;
        };
      },
    });
    const racingReviewService = new HumanReviewService({
      humanReviewRepo: reviewRepo,
      caseRepo: racingCaseRepo as CaseRepository,
      actionRepo,
      customerRepo,
      merchantRepo,
      policyConfigRepo,
      commitmentRepo,
      outcomeRepo,
      auditRepo,
      policyEngine,
      actionExecutor,
      clock: testClock,
    });

    const result = await racingReviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'Controlled terminal race',
    });

    expect(result.created).toBe(false);
    expect(result.caseStatus).toBe(CaseStatus.RECOVERED);
    expect(result.reason).toContain('terminal');
    expect(result.review?.status).toBe(ReviewStatus.CLOSED);
    expect(simulatedProvider.dispatchedCalls).toHaveLength(0);

    const finalCase = await caseRepo.getCaseById(merchantAId, testCase.id);
    expect(finalCase?.status).toBe(CaseStatus.RECOVERED);
    const activeReviews = await prisma.humanReview.count({
      where: {
        merchantId: merchantAId,
        caseId: testCase.id,
        status: { in: [ReviewStatus.PENDING, ReviewStatus.TAKEN_OVER] },
      },
    });
    expect(activeReviews).toBe(0);

    const audits = await auditRepo.listByCase(merchantAId, testCase.id);
    expect(audits.filter((audit) => audit.eventType === 'REVIEW_REQUESTED')).toHaveLength(1);
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'REVIEW_STALE',
        reasonCode: 'REVIEW_CREATION_TERMINAL_CASE_RACE',
      }),
    ]));
  });

  // B. Approval Happy Path & Double Revalidation
  it('Scenario B: Reviewer approves pending review -> fresh policy ALLOW -> ActionExecutor executes -> review APPROVED -> provider called once', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);
    const req = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'Needs check',
    });

    const approval = await reviewService.approveReview(merchantAId, req.review!.id, userReviewerAId, {
      notes: 'Verified account and approved recovery email',
    });

    expect(approval.approved).toBe(true);
    expect(approval.review?.status).toBe(ReviewStatus.APPROVED);
    expect(approval.executionResult?.success).toBe(true);
    expect(approval.action?.status).toBe(ActionExecutionStatus.SUCCESS);

    // Provider called exactly once
    expect(simulatedProvider.dispatchedCalls).toHaveLength(1);

    // Verify persisted review in DB
    const dbReview = await reviewRepo.getReviewById(merchantAId, req.review!.id);
    expect(dbReview.status).toBe(ReviewStatus.APPROVED);
    expect(dbReview.reviewerId).toBe(userReviewerAId);
    expect(dbReview.revalidatedPolicyDecision).toBe(PolicyDecision.ALLOW);

    // Verify audit logs
    const audits = await auditRepo.listByCase(merchantAId, testCase.id);
    expect(audits.some((a) => a.eventType === 'REVIEW_APPROVED')).toBe(true);
    expect(audits.some((a) => a.eventType === 'REVIEW_EXECUTION_AUTHORIZED')).toBe(true);
    expect(audits.some((a) => a.eventType === 'ACTION_DISPATCHED')).toBe(true);
  });

  // C. Safety Race: Opt-Out Before ActionExecutor Dispatch
  it('Scenario C: Review approved -> before ActionExecutor dispatch customer opts out -> ActionExecutor revalidation DENY -> action CANCELLED -> 0 provider calls', async () => {
    if (!dbAvailable) return;

    const { customer, testCase, planVersion } = await createTestCase(merchantAId);
    const req = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'Pre-dispatch race test',
    });

    // Human approves and authorizes action
    // Step 1: Resolve review and authorize action in PENDING state
    const resolvedReview = await reviewRepo.resolveReview(merchantAId, req.review!.id, {
      reviewerId: userReviewerAId,
      status: ReviewStatus.APPROVED,
      expectedStatus: ReviewStatus.PENDING,
      reviewDecision: 'APPROVED',
      revalidatedPolicyDecision: PolicyDecision.ALLOW,
    });

    const authResult = await actionExecutor.authorizeAndCreateAction(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      actionType: planVersion.proposedActionType,
      actionParams: planVersion.proposedActionParams as Record<string, unknown>,
      policyEvaluation: {
        decision: PolicyDecision.ALLOW,
        reasonCode: 'VALID_POLICY',
        rationale: 'Human approved',
        evaluatedAt: new Date(),
        violations: [],
      },
      reviewId: resolvedReview.id,
    });

    expect(authResult.authorized).toBe(true);
    expect(authResult.action?.status).toBe(ActionExecutionStatus.PENDING);

    // RACE CONDITION OCCURS: Customer opts out in DB before ActionExecutor.executeAction executes
    await customerRepo.setOptOut(merchantAId, customer.id, true);
    await customerRepo.setContactConsent(merchantAId, customer.id, false);

    // ActionExecutor claims and runs fresh policy revalidation
    const executionResult = await actionExecutor.executeAction(merchantAId, authResult.action!.id);

    // Fresh revalidation detects customer opted out -> blocks execution
    expect(executionResult.executed).toBe(false);
    expect(executionResult.blockedByPolicy).toBe(true);
    expect(executionResult.policyDecision).toBe(PolicyDecision.DENY);
    expect(executionResult.policyReasonCode).toBe('CUSTOMER_OPTED_OUT');
    expect(executionResult.action.status).toBe(ActionExecutionStatus.CANCELLED);

    // ZERO provider calls made
    expect(simulatedProvider.dispatchedCalls).toHaveLength(0);

    // Verify DB action status is CANCELLED
    const dbAction = await actionRepo.getActionById(merchantAId, authResult.action!.id);
    expect(dbAction?.status).toBe(ActionExecutionStatus.CANCELLED);

    // Verify ACTION_BLOCKED_BY_POLICY audit recorded
    const audits = await auditRepo.listByCase(merchantAId, testCase.id);
    const blockedAudit = audits.find((a) => a.eventType === 'ACTION_BLOCKED_BY_POLICY');
    expect(blockedAudit).toBeDefined();
    expect(blockedAudit?.reasonCode).toBe('CUSTOMER_OPTED_OUT');
  });

  // D. Stale Proposal Rejection
  it('Scenario D: Case replanned to version 2 -> human attempts to approve review for v1 -> fails safely with zero execution and REVIEW_STALE audit', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);
    const req = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id, // v1
      reasonForReview: 'Review v1',
    });

    // Replanned to v2
    await prisma.recoveryPlanVersion.create({
      data: {
        caseId: testCase.id,
        version: 2,
        diagnosisCode: 'HARD_DECLINE',
        diagnosisSummary: 'Card expired',
        reasoningSummary: 'Stale version 2 plan for card expiration, requiring fresh review before execution.',
        proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        proposedActionParams: {},
        confidence: 0.9,
      },
    });

    const approval = await reviewService.approveReview(merchantAId, req.review!.id, userReviewerAId);

    expect(approval.approved).toBe(false);
    expect(approval.stale).toBe(true);

    // Zero actions created
    const actions = await prisma.recoveryAction.findMany({
      where: { caseId: testCase.id, case: { merchantId: merchantAId } },
    });
    expect(actions).toHaveLength(0);

    // Verify REVIEW_STALE audit
    const audits = await auditRepo.listByCase(merchantAId, testCase.id);
    expect(audits.some((a) => a.eventType === 'REVIEW_STALE')).toBe(true);
  });

  // E. Case Already Recovered / Stopped
  it('Scenario E: Case marked RECOVERED externally -> human attempts approval -> fails safely with zero execution', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);
    const req = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'Reviewing',
    });

    // External recovery occurs
    await caseRepo.compareAndSetStatus(merchantAId, testCase.id, CaseStatus.NEEDS_REVIEW, CaseStatus.RECOVERED);

    const approval = await reviewService.approveReview(merchantAId, req.review!.id, userReviewerAId);

    expect(approval.approved).toBe(false);
    expect(approval.stale).toBe(true);

    const actions = await prisma.recoveryAction.findMany({
      where: { caseId: testCase.id, case: { merchantId: merchantAId } },
    });
    expect(actions).toHaveLength(0);
  });

  // F. Concurrency Resolution Race
  it('Scenario F: Concurrent resolutions via Promise.all (approve, reject, takeOver) -> exactly 1 succeeds, others conflict -> no double execution', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);
    const req = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'Concurrency test review',
    });

    const reviewId = req.review!.id;

    // Trigger approve, reject, and takeOver concurrently
    const results = await Promise.allSettled([
      reviewService.approveReview(merchantAId, reviewId, userAdminAId, { notes: 'Approve concurrent' }),
      reviewService.rejectReview(merchantAId, reviewId, userReviewerAId, { reason: 'Reject concurrent' }),
      reviewService.takeOverReview(merchantAId, reviewId, userAdminAId, { notes: 'Takeover concurrent' }),
    ]);

    // Exactly one must succeed, the others must fail with ReviewStateConflictError
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(2);

    for (const rej of rejected) {
      if (rej.status === 'rejected') {
        expect(rej.reason).toBeInstanceOf(ReviewStateConflictError);
      }
    }

    // Verify DB state has exactly 1 resolved status
    const dbReview = await reviewRepo.getReviewById(merchantAId, reviewId);
    expect(dbReview.status).not.toBe(ReviewStatus.PENDING);
  });

  // G. Cross-Tenant Security
  it('Scenario G: Merchant B cannot fetch, approve, or reject Merchant A review', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);
    const req = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'Tenant A review',
    });

    const reviewId = req.review!.id;

    // Merchant B attempts to fetch Merchant A's review
    await expect(reviewRepo.getReviewById(merchantBId, reviewId)).rejects.toThrow();

    // Merchant B attempts to approve Merchant A's review
    await expect(
      reviewService.approveReview(merchantBId, reviewId, userAdminBId),
    ).rejects.toThrow();

    // Merchant B attempts to reject Merchant A's review
    await expect(
      reviewService.rejectReview(merchantBId, reviewId, userAdminBId, { reason: 'Cross tenant attack' }),
    ).rejects.toThrow();
  });

  // H. Role & Reviewer Membership Enforcement in DB
  it('Scenario H: Non-existent or other-merchant reviewer cannot resolve review in DB', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);
    const req = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'Role check review',
    });

    const reviewId = req.review!.id;

    // Non-existent user attempts approval
    await expect(
      reviewService.approveReview(merchantAId, reviewId, nonExistentUserId),
    ).rejects.toThrow(UnauthorizedReviewerError);

    // Other-merchant user attempts rejection
    await expect(
      reviewService.rejectReview(merchantAId, reviewId, userAdminBId, { reason: 'Cross merchant rejection' }),
    ).rejects.toThrow(UnauthorizedReviewerError);

    // Review remains PENDING in DB
    const dbReview = await reviewRepo.getReviewById(merchantAId, reviewId);
    expect(dbReview.status).toBe(ReviewStatus.PENDING);
  });

  // I. Take Over Case
  it('Scenario I: Review taken over -> marked TAKEN_OVER -> audit written -> orchestrator halts autonomous processing', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);
    const req = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'VIP customer needs human takeover',
    });

    const takeover = await reviewService.takeOverReview(merchantAId, req.review!.id, userAdminAId, {
      notes: 'Account manager taking over manually',
    });

    expect(takeover.takenOver).toBe(true);
    expect(takeover.review?.status).toBe(ReviewStatus.TAKEN_OVER);

    // Verify audit
    const audits = await auditRepo.listByCase(merchantAId, testCase.id);
    expect(audits.some((a) => a.eventType === 'REVIEW_TAKEN_OVER')).toBe(true);

    // When orchestrator tries to run iteration on this case, it halts due to active takeover
    const iteration = await orchestrator.runIteration(merchantAId, testCase.id, 'MANUAL_DISPATCH');

    expect(iteration.iterationCompleted).toBe(false);
    expect(iteration.error).toBe('CASE_TAKEN_OVER_BY_HUMAN');

    // Zero autonomous actions created
    const actions = await prisma.recoveryAction.findMany({
      where: { caseId: testCase.id, case: { merchantId: merchantAId } },
    });
    expect(actions).toHaveLength(0);
  });
});
