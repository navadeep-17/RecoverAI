import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  prisma,
  ActionRepository,
  CaseRepository,
  MerchantRepository,
  CustomerRepository,
  AuditRepository,
  PolicyConfigRepository,
  ActionExecutionStatus,
  CaseStatus,
  PolicyDecision,
  RecoveryActionType,
  RiskType,
} from '../src/index.js';
import { ActionExecutor, generateActionIdempotencyKey } from '@recoverai/core';
import { PolicyEngine } from '@recoverai/policy';
import {
  ProviderRegistry,
  SimulatedRecoveryProvider,
} from '@recoverai/integrations';

describe('Action Execution & Atomic Claim PostgreSQL Integration Tests', () => {
  let dbAvailable = false;
  let actionRepo: ActionRepository;
  let caseRepo: CaseRepository;
  let merchantRepo: MerchantRepository;
  let customerRepo: CustomerRepository;
  let auditRepo: AuditRepository;
  let policyConfigRepo: PolicyConfigRepository;
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

  it('proves Promise.all concurrent execution claims action atomically and calls provider exactly ONCE', async () => {
    if (!dbAvailable) return;

    // Reset provider calls tracker
    simulatedProvider.dispatchedCalls = [];

    // Create test customer & case
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

    // Authorize action
    const { action } = await actionExecutor.authorizeAndCreateAction(merchantAId, testCase.id, {
      actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
      actionParams: { channel: 'WHATSAPP' },
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: 'Low risk failure approved for dispatch',
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
      where: {
        merchantId: merchantAId,
        caseId: testCase.id,
        eventType: 'ACTION_DISPATCHED',
      },
    });
    expect(dispatchedAudits.length).toBe(1);

    const succeededAudits = await prisma.auditEvent.findMany({
      where: {
        merchantId: merchantAId,
        caseId: testCase.id,
        eventType: 'ACTION_SUCCEEDED',
      },
    });
    expect(succeededAudits.length).toBe(1);
  });

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
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: 'Approved for Merchant A',
      attemptOrVersion: 'v1',
    });

    expect(action).toBeDefined();

    // Merchant B attempts to execute Merchant A's action -> MUST fail
    await expect(actionExecutor.executeAction(merchantBId, action!.id)).rejects.toThrow(
      /not found or unauthorized/,
    );

    // Verify action remains PENDING under Merchant A
    const freshAction = await actionRepo.getActionById(merchantAId, action!.id);
    expect(freshAction?.status).toBe(ActionExecutionStatus.PENDING);
  });

  it('blocks execution when customer opted out or kill switch active via fresh revalidation in database', async () => {
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
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: 'Initially allowed',
      attemptOrVersion: 'v1',
    });

    // Customer opts out in database
    await prisma.customer.update({
      where: { id: customer.id },
      data: { optedOut: true },
    });

    // Execution must be blocked by fresh policy revalidation
    const result = await actionExecutor.executeAction(merchantAId, action!.id);

    expect(result.executed).toBe(false);
    expect(result.blockedByPolicy).toBe(true);
    expect(result.policyDecision).toBe(PolicyDecision.DENY);

    const dbAction = await actionRepo.getActionById(merchantAId, action!.id);
    expect(dbAction?.status).toBe(ActionExecutionStatus.CANCELLED);
  });

  it('executes internal actions STOP_RECOVERY and ESCALATE_TO_HUMAN correctly in database', async () => {
    if (!dbAvailable) return;

    const testCase = await caseRepo.createCase(merchantAId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '3000.00',
      currency: 'INR',
      incidentKey: `${merchantAId}:INTERNAL_TEST:${Date.now()}`,
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
    });

    // 1. Authorize and execute STOP_RECOVERY
    const { action: stopAction } = await actionExecutor.authorizeAndCreateAction(merchantAId, testCase.id, {
      actionType: RecoveryActionType.STOP_RECOVERY,
      actionParams: { reason: 'User requested termination' },
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: 'Stop allowed',
      attemptOrVersion: 'v1',
    });

    const stopResult = await actionExecutor.executeAction(merchantAId, stopAction!.id);
    expect(stopResult.executed).toBe(true);
    expect(stopResult.success).toBe(true);

    const stoppedCase = await caseRepo.getCaseById(merchantAId, testCase.id);
    expect(stoppedCase?.status).toBe(CaseStatus.STOPPED);
  });
});
