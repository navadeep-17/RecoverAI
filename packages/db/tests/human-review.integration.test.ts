import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma, ReviewStatus, UserRole } from '@prisma/client';
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
  const userMemberAId = 'usr_rev_member_a_03';
  const userAdminBId = 'usr_rev_admin_b_01';

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
        auditRepo,
        policyConfigRepo,
        commitmentRepo,
        policyEngine,
        providerRegistry,
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
            role: UserRole.MERCHANT_ADMIN,
            passwordHash: 'hash_a_admin',
          },
          {
            id: userReviewerAId,
            merchantId: merchantAId,
            email: `reviewer-a-${Date.now()}@example.com`,
            name: 'Reviewer A',
            role: UserRole.REVIEWER,
            passwordHash: 'hash_a_reviewer',
          },
          {
            id: userMemberAId,
            merchantId: merchantAId,
            email: `member-a-${Date.now()}@example.com`,
            name: 'Member A (Unauthorized)',
            role: UserRole.MEMBER,
            passwordHash: 'hash_a_member',
          },
          {
            id: userAdminBId,
            merchantId: merchantBId,
            email: `admin-b-${Date.now()}@example.com`,
            name: 'Admin B',
            role: UserRole.MERCHANT_ADMIN,
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
    const customer = await customerRepo.createCustomer(mId, {
      name: 'Integration Customer',
      email: `cust_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@example.com`,
      phone: '+919876543210',
      contactConsent: true,
      optedOut: false,
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
        merchantId: mId,
        caseId: c.id,
        version: 1,
        diagnosisCode: 'CARD_DECLINED',
        diagnosisSummary: 'Card temporarily declined',
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        proposedActionParams: { channel: 'EMAIL', discountOffered: 0 },
        confidence: 0.85,
        llmPrompt: 'test prompt',
        llmResponse: 'test response',
      },
    });

    return { customer, testCase: c, planVersion };
  }

  // A. Review Creation
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

  // B. Approval Happy Path
  it('Scenario B: Reviewer approves pending review -> fresh policy ALLOW -> ActionExecutor executes -> review APPROVED -> audits correct', async () => {
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

  // C. Hard Invariant Prevents Approval Override (Opt-Out)
  it('Scenario C: Customer opts out while review is pending -> human approves -> fresh policy rejects (DENY) -> zero execution -> audit REVIEW_EXECUTION_BLOCKED', async () => {
    if (!dbAvailable) return;

    const { customer, testCase, planVersion } = await createTestCase(merchantAId);
    const req = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'Needs check',
    });

    // Customer opts out before human approves
    await customerRepo.updateConsent(merchantAId, customer.id, false, true);

    const approval = await reviewService.approveReview(merchantAId, req.review!.id, userReviewerAId);

    expect(approval.approved).toBe(false);
    expect(approval.blockedByPolicy).toBe(true);
    expect(approval.policyDecision).toBe(PolicyDecision.DENY);
    expect(approval.policyReasonCode).toBe('CUSTOMER_OPTED_OUT');

    // Verify ZERO actions executed in DB
    const actions = await actionRepo.listActionsForCase(merchantAId, testCase.id);
    expect(actions).toHaveLength(0);

    // Verify review remains PENDING
    const dbReview = await reviewRepo.getReviewById(merchantAId, req.review!.id);
    expect(dbReview.status).toBe(ReviewStatus.PENDING);

    // Verify audit
    const audits = await auditRepo.listByCase(merchantAId, testCase.id);
    expect(audits.some((a) => a.eventType === 'REVIEW_EXECUTION_BLOCKED')).toBe(true);
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
        merchantId: merchantAId,
        caseId: testCase.id,
        version: 2,
        diagnosisCode: 'HARD_DECLINE',
        diagnosisSummary: 'Card expired',
        proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        proposedActionParams: {},
        confidence: 0.9,
        llmPrompt: 'test prompt 2',
        llmResponse: 'test response 2',
      },
    });

    const approval = await reviewService.approveReview(merchantAId, req.review!.id, userReviewerAId);

    expect(approval.approved).toBe(false);
    expect(approval.stale).toBe(true);

    // Zero actions created
    const actions = await actionRepo.listActionsForCase(merchantAId, testCase.id);
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

    const actions = await actionRepo.listActionsForCase(merchantAId, testCase.id);
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

  // H. Role Enforcement
  it('Scenario H: User with unauthorized role (MEMBER) cannot resolve review', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);
    const req = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'Role check review',
    });

    const reviewId = req.review!.id;

    // User with MEMBER role attempts approval
    await expect(
      reviewService.approveReview(merchantAId, reviewId, userMemberAId),
    ).rejects.toThrow(UnauthorizedReviewerError);

    // User with MEMBER role attempts rejection
    await expect(
      reviewService.rejectReview(merchantAId, reviewId, userMemberAId, { reason: 'Unauthorized rejection' }),
    ).rejects.toThrow(UnauthorizedReviewerError);

    // Review remains PENDING in DB
    const dbReview = await reviewRepo.getReviewById(merchantAId, reviewId);
    expect(dbReview.status).toBe(ReviewStatus.PENDING);
  });

  // I. Duplicate Review Prevention
  it('Scenario I: Multiple review requests for same proposal/version do not create duplicate active reviews', async () => {
    if (!dbAvailable) return;

    const { testCase, planVersion } = await createTestCase(merchantAId);

    // Request review twice with same caseId and planVersionId
    const res1 = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'First request',
    });

    const res2 = await reviewService.requestReview(merchantAId, testCase.id, {
      planVersionId: planVersion.id,
      reasonForReview: 'Duplicate request',
    });

    expect(res1.review.id).toBe(res2.review.id);

    // Verify DB count of reviews for this case
    const allReviews = await reviewRepo.listReviews(merchantAId, { caseId: testCase.id });
    expect(allReviews).toHaveLength(1);
  });

  // J. Take Over Case
  it('Scenario J: Review taken over -> marked TAKEN_OVER -> audit written -> orchestrator halts autonomous processing', async () => {
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
    const claim = await triggerRepo.claimTrigger(merchantAId, testCase.id, 'MANUAL_DISPATCH', {});
    const iteration = await orchestrator.runIteration(merchantAId, testCase.id, claim);

    expect(iteration.iterationCompleted).toBe(false);
    expect(iteration.error).toBe('CASE_TAKEN_OVER_BY_HUMAN');

    // Zero autonomous actions created
    const actions = await actionRepo.listActionsForCase(merchantAId, testCase.id);
    expect(actions).toHaveLength(0);
  });
});