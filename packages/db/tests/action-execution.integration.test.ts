import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  prisma,
  ActionRepository,
  CaseRepository,
  MerchantRepository,
  CustomerRepository,
  AuditRepository,
  PolicyConfigRepository,
  CommitmentRepository,
  ActionExecutionStatus,
  CaseStatus,
  PolicyDecision,
  RecoveryActionType,
  RiskType,
} from '../src/index.js';
import { ActionExecutor, generateActionIdempotencyKey, PolicyEvaluationResult } from '@recoverai/core';
import { PolicyEngine } from '@recoverai/policy';
import {
  ProviderRegistry,
  SimulatedRecoveryProvider,
} from '@recoverai/integrations';

/** Build a typed PolicyEvaluationResult for ALLOW decisions in tests. */
function allowResult(): PolicyEvaluationResult {
  return {
    decision: PolicyDecision.ALLOW,
    reasonCode: 'POLICY_ALLOWED',
    rationale: 'Integration test allow',
    evaluatedAt: new Date(),
  };
}

describe('Action Execution & Atomic Claim PostgreSQL Integration Tests', () => {
  let dbAvailable = false;
  let actionRepo: ActionRepository;
  let caseRepo: CaseRepository;
  let merchantRepo: MerchantRepository;
  let customerRepo: CustomerRepository;
  let auditRepo: AuditRepository;
  let policyConfigRepo: PolicyConfigRepository;
  let commitmentRepo: CommitmentRepository;
  let policyEngine: PolicyEngine;
  let simulatedProvider: SimulatedRecoveryProvider;
  let providerRegistry: ProviderRegistry;
  let actionExecutor: ActionExecutor;

  let merchantAId: string;
  let merchantBId: string;

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbAvailable = true;

      actionRepo = new ActionRepository();
      caseRepo = new CaseRepository();
      merchantRepo = new MerchantRepository();
      customerRepo = new CustomerRepository();
      auditRepo = new AuditRepository();
      policyConfigRepo = new PolicyConfigRepository();
      commitmentRepo = new CommitmentRepository();
      policyEngine = new PolicyEngine();
      simulatedProvider = new SimulatedRecoveryProvider();
      providerRegistry = new ProviderRegistry([simulatedProvider]);

      actionExecutor = new ActionExecutor({
        actionRepo,
        caseRepo,
        merchantRepo,
        customerRepo,
        auditRepo,
        policyConfigRepo,
        commitmentRepo,
        policyEngine,
        providerRegistry,
        clock: () => new Date('2026-08-28T14:00:00+05:30'),
      });

      const mchA = await merchantRepo.createMerchant({
        name: 'Action Exec Merchant A',
        slug: `mch-act-a-${Date.now()}`,
      });
      merchantAId = mchA.id;

      const mchB = await merchantRepo.createMerchant({
        name: 'Action Exec Merchant B',
        slug: `mch-act-b-${Date.now()}`,
      });
      merchantBId = mchB.id;
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      if (merchantAId) await merchantRepo.deleteMerchant(merchantAId).catch(() => {});
      if (merchantBId) await merchantRepo.deleteMerchant(merchantBId).catch(() => {});
      await prisma.$disconnect();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('proves Promise.all concurrent execution claims action atomically and calls provider exactly ONCE', async () => {
    if (!dbAvailable) return;

    simulatedProvider.dispatchedCalls = [];

    const customer = await customerRepo.getOrCreateCustomer(merchantAId, {
      name: 'Concurrent Customer',
      email: `conc_${Date.now()}@example.com`,
      contactConsent: true,
    });

    const testCase = await caseRepo.createCase(merchantAId, {
      customerId: customer.id,
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '2000.00',
      currency: 'INR',
      incidentKey: `${merchantAId}:CONC_ACT:${Date.now()}`,
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
    });

    const { action } = await actionExecutor.authorizeAndCreateAction(merchantAId, testCase.id, {
      actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
      actionParams: { channel: 'WHATSAPP' },
      policyEvaluation: allowResult(),
      attemptOrVersion: 'v1',
    });

    expect(action).toBeDefined();
    const actionId = action!.id;

    // Concurrently trigger 5 workers to execute the exact same action
    const executionPromises = Array.from({ length: 5 }, () =>
      actionExecutor.executeAction(merchantAId, actionId),
    );

    const results = await Promise.all(executionPromises);

    // 1. Exactly ONE worker successfully executed and dispatched the action
    const successfulDispatches = results.filter((r) => r.executed && r.success);
    expect(successfulDispatches.length).toBe(1);

    // 2. The other 4 workers observed alreadyClaimed === true and did NOT call provider
    const alreadyClaimedResults = results.filter((r) => !r.executed && r.alreadyClaimed);
    expect(alreadyClaimedResults.length).toBe(4);

    // 3. Provider adapter was called exactly ONCE
    expect(simulatedProvider.dispatchedCalls.length).toBe(1);
    expect(simulatedProvider.dispatchedCalls[0].actionId).toBe(actionId);

    // 4. Action in database is in SUCCESS status with execution metadata
    const dbAction = await actionRepo.getActionById(merchantAId, actionId);
    expect(dbAction?.status).toBe(ActionExecutionStatus.SUCCESS);
    expect(dbAction?.providerName).toBe('SIMULATED_RECOVERY_PROVIDER');
    expect(dbAction?.externalActionId).toBeDefined();

    // 5. Audit trail contains exactly ONE ACTION_DISPATCHED and ONE ACTION_SUCCEEDED
    const dispatchedAudits = await prisma.auditEvent.findMany({
      where: { merchantId: merchantAId, caseId: testCase.id, eventType: 'ACTION_DISPATCHED' },
    });
    expect(dispatchedAudits.length).toBe(1);

    const succeededAudits = await prisma.auditEvent.findMany({
      where: { merchantId: merchantAId, caseId: testCase.id, eventType: 'ACTION_SUCCEEDED' },
    });
    expect(succeededAudits.length).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('enforces strict tenant isolation: Merchant B cannot claim or execute Merchant A action', async () => {
    if (!dbAvailable) return;

    const testCase = await caseRepo.createCase(merchantAId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '1000.00',
      currency: 'INR',
      incidentKey: `${merchantAId}:CROSS_TENANT:${Date.now()}`,
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
    });

    const { action } = await actionExecutor.authorizeAndCreateAction(merchantAId, testCase.id, {
      actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      actionParams: {},
      policyEvaluation: allowResult(),
      attemptOrVersion: 'v1',
    });

    expect(action).toBeDefined();

    // Merchant B attempts to execute Merchant A's action — MUST fail
    await expect(actionExecutor.executeAction(merchantBId, action!.id)).rejects.toThrow(
      /not found or unauthorized/,
    );

    // Action remains PENDING under Merchant A
    const freshAction = await actionRepo.getActionById(merchantAId, action!.id);
    expect(freshAction?.status).toBe(ActionExecutionStatus.PENDING);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('blocks execution via fresh revalidation (claim first, then detect opt-out, CAS EXECUTING→CANCELLED)', async () => {
    if (!dbAvailable) return;

    const customer = await customerRepo.getOrCreateCustomer(merchantAId, {
      name: 'Opted Out Customer',
      email: `optout_${Date.now()}@example.com`,
      contactConsent: true,
    });

    const testCase = await caseRepo.createCase(merchantAId, {
      customerId: customer.id,
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '1000.00',
      currency: 'INR',
      incidentKey: `${merchantAId}:OPTOUT_TEST:${Date.now()}`,
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
    });

    const { action } = await actionExecutor.authorizeAndCreateAction(merchantAId, testCase.id, {
      actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
      actionParams: { channel: 'WHATSAPP' },
      policyEvaluation: allowResult(),
      attemptOrVersion: 'v1',
    });

    // Customer opts out in database between authorization and execution
    await prisma.customer.update({
      where: { id: customer.id },
      data: { optedOut: true },
    });

    const result = await actionExecutor.executeAction(merchantAId, action!.id);

    // Fresh policy revalidation (after claim) detects opt-out → DENY → CANCELLED
    expect(result.executed).toBe(false);
    expect(result.blockedByPolicy).toBe(true);
    expect(result.policyDecision).toBe(PolicyDecision.DENY);

    const dbAction = await actionRepo.getActionById(merchantAId, action!.id);
    // Claim happened, then CAS rolled back EXECUTING → CANCELLED
    expect(dbAction?.status).toBe(ActionExecutionStatus.CANCELLED);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('idempotent authorization: same idempotency key twice creates exactly one RecoveryAction and one ACTION_AUTHORIZED audit', async () => {
    if (!dbAvailable) return;

    const testCase = await caseRepo.createCase(merchantAId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '2500.00',
      currency: 'INR',
      incidentKey: `${merchantAId}:IDEMP_AUTH:${Date.now()}`,
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
    });

    const params = {
      actionType: RecoveryActionType.SEND_CHECKOUT_RECOVERY,
      actionParams: { channel: 'EMAIL' },
      policyEvaluation: allowResult(),
      attemptOrVersion: 'v1',
    };

    const first = await actionExecutor.authorizeAndCreateAction(merchantAId, testCase.id, params);
    const second = await actionExecutor.authorizeAndCreateAction(merchantAId, testCase.id, params);

    expect(first.authorized).toBe(true);
    expect(second.authorized).toBe(true);

    // Same action returned
    expect(first.action?.id).toBe(second.action?.id);

    // Only one RecoveryAction in DB for this idempotency key
    const idempotencyKey = generateActionIdempotencyKey(
      merchantAId,
      testCase.id,
      RecoveryActionType.SEND_CHECKOUT_RECOVERY,
      'v1',
    );
    const actionsInDb = await prisma.recoveryAction.count({
      where: { idempotencyKey },
    });
    expect(actionsInDb).toBe(1);

    // Exactly one ACTION_AUTHORIZED audit
    const authorizedAudits = await prisma.auditEvent.findMany({
      where: {
        merchantId: merchantAId,
        caseId: testCase.id,
        eventType: 'ACTION_AUTHORIZED',
      },
    });
    expect(authorizedAudits.length).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('RECORD_PROMISE_TO_PAY: persists authoritative RecoveryCommitment in database', async () => {
    if (!dbAvailable) return;

    const customer = await customerRepo.getOrCreateCustomer(merchantAId, {
      name: 'PTP Customer',
      email: `ptp_${Date.now()}@example.com`,
      contactConsent: true,
    });

    const testCase = await caseRepo.createCase(merchantAId, {
      customerId: customer.id,
      riskType: RiskType.OVERDUE_RECEIVABLE,
      amountAtRisk: '8000.00',
      currency: 'INR',
      incidentKey: `${merchantAId}:PTP_TEST:${Date.now()}`,
      contextJson: {},
    });

    const { action } = await actionExecutor.authorizeAndCreateAction(merchantAId, testCase.id, {
      actionType: RecoveryActionType.RECORD_PROMISE_TO_PAY,
      actionParams: {
        promisedAmount: '8000.00',
        promisedDate: '2026-09-15T00:00:00.000Z',
        extractedFromText: 'Customer agreed to pay by 15th September',
      },
      policyEvaluation: allowResult(),
      attemptOrVersion: 'v1',
    });

    const execResult = await actionExecutor.executeAction(merchantAId, action!.id);

    expect(execResult.success).toBe(true);
    expect(execResult.action?.status).toBe(ActionExecutionStatus.SUCCESS);

    // Verify authoritative RecoveryCommitment exists in database
    const commitments = await prisma.recoveryCommitment.findMany({
      where: { caseId: testCase.id },
    });
    expect(commitments.length).toBe(1);
    expect(commitments[0].status).toBe('PENDING');
    expect(new prisma.Prisma.Decimal(commitments[0].promisedAmount).equals(new prisma.Prisma.Decimal('8000.00'))).toBe(true);
    expect(commitments[0].extractedFromText).toBe('Customer agreed to pay by 15th September');

    // executionMetadata references the commitmentId
    const dbAction = await actionRepo.getActionById(merchantAId, action!.id);
    const meta = dbAction?.executionMetadata as Record<string, unknown> | null;
    expect(meta?.commitmentId).toBe(commitments[0].id);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('executes internal actions STOP_RECOVERY correctly in database', async () => {
    if (!dbAvailable) return;

    const testCase = await caseRepo.createCase(merchantAId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '3000.00',
      currency: 'INR',
      incidentKey: `${merchantAId}:INTERNAL_TEST:${Date.now()}`,
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
    });

    const { action: stopAction } = await actionExecutor.authorizeAndCreateAction(
      merchantAId,
      testCase.id,
      {
        actionType: RecoveryActionType.STOP_RECOVERY,
        actionParams: { reason: 'User requested termination' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      },
    );

    const stopResult = await actionExecutor.executeAction(merchantAId, stopAction!.id);
    expect(stopResult.executed).toBe(true);
    expect(stopResult.success).toBe(true);

    const stoppedCase = await caseRepo.getCaseById(merchantAId, testCase.id);
    expect(stoppedCase?.status).toBe(CaseStatus.STOPPED);

    // No ACTION_DISPATCHED audit for internal action
    const dispatchedAudits = await prisma.auditEvent.findMany({
      where: { merchantId: merchantAId, caseId: testCase.id, eventType: 'ACTION_DISPATCHED' },
    });
    expect(dispatchedAudits.length).toBe(0);
  });
});
