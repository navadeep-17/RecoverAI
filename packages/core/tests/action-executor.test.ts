import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ActionExecutionStatus,
  CaseStatus,
  PolicyDecision,
  RecoveryAction,
  RecoveryActionType,
  RiskType,
} from '@prisma/client';
import {
  ActionExecutor,
  generateActionIdempotencyKey,
  PolicyEvaluationResult,
  ProviderRegistry as BaseProviderRegistry,
} from '../src/index.js';
import { PolicyEngine } from '@recoverai/policy';
import {
  IActionProvider,
  ProviderExecutionOutcome,
  ProviderRegistry,
  SimulatedRecoveryProvider,
} from '@recoverai/integrations';
import { ActionExecutionError } from '@recoverai/shared';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Build a typed PolicyEvaluationResult for ALLOW decisions in tests. */
function allowResult(reasonCode = 'POLICY_ALLOWED'): PolicyEvaluationResult {
  return {
    decision: PolicyDecision.ALLOW,
    reasonCode,
    rationale: 'Test allow rationale',
    evaluatedAt: new Date(),
  };
}

function denyResult(reasonCode = 'POLICY_DENIED', rationale = 'Test deny rationale'): PolicyEvaluationResult {
  return {
    decision: PolicyDecision.DENY,
    reasonCode,
    rationale,
    evaluatedAt: new Date(),
  };
}

function reviewResult(reasonCode = 'POLICY_REVIEW', rationale = 'Test review rationale'): PolicyEvaluationResult {
  return {
    decision: PolicyDecision.REVIEW,
    reasonCode,
    rationale,
    evaluatedAt: new Date(),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────────────────

describe('ActionExecutor Unit Tests', () => {
  let actionExecutor: ActionExecutor;
  let mockActionRepo: any;
  let mockCaseRepo: any;
  let mockCustomerRepo: any;
  let mockPolicyConfigRepo: any;
  let mockAuditRepo: any;
  let mockMerchantRepo: any;
  let mockCommitmentRepo: any;
  let mockJobScheduler: any;
  let policyEngine: PolicyEngine;
  let simulatedProvider: SimulatedRecoveryProvider;
  let providerRegistry: ProviderRegistry;

  const merchantId = 'mch_exec_test_01';
  const caseId = 'case_exec_test_01';
  const customerId = 'cust_exec_test_01';

  let inMemoryActions: Map<string, any>;
  let inMemoryCases: Map<string, any>;
  let inMemoryCustomers: Map<string, any>;
  let inMemoryCommitments: any[];
  let inMemoryAudits: any[];

  beforeEach(() => {
    inMemoryActions = new Map();
    inMemoryCases = new Map();
    inMemoryCustomers = new Map();
    inMemoryCommitments = [];
    inMemoryAudits = [];

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
      status: CaseStatus.OPEN,
      openedAt: new Date(Date.now() - 3600000),
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
      customer: inMemoryCustomers.get(customerId),
      actions: [],
      outcomes: [],
    });

    mockActionRepo = {
      createAction: vi.fn(async (_mId: string, cId: string, params: any) => {
        const id = `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const action: any = {
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
          executionMetadata: null,
          errorMessage: null,
          executedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        inMemoryActions.set(id, action);
        return action;
      }),
      findActionByIdempotencyKey: vi.fn(async (_mId: string, idempotencyKey: string) => {
        return Array.from(inMemoryActions.values()).find(
          (a) => a.idempotencyKey === idempotencyKey,
        ) || null;
      }),
      getActionById: vi.fn(async (_mId: string, aId: string) => {
        return inMemoryActions.get(aId) || null;
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
      updateActionStatus: vi.fn(async (_mId: string, aId: string, params: any) => {
        const action = inMemoryActions.get(aId);
        if (!action) throw new Error('Action not found');
        action.status = params.status;
        if (params.providerName) action.providerName = params.providerName;
        if (params.externalActionId) action.externalActionId = params.externalActionId;
        if (params.executionMetadata) action.executionMetadata = params.executionMetadata;
        if (params.errorMessage) action.errorMessage = params.errorMessage;
        action.executedAt = new Date();
        return action;
      }),
      transitionActionStatus: vi.fn(
        async (_mId: string, aId: string, expectedStatus: ActionExecutionStatus, nextStatus: ActionExecutionStatus, extras?: any) => {
          const action = inMemoryActions.get(aId);
          if (!action) return { transitioned: false, action: null };
          if (action.status !== expectedStatus) return { transitioned: false, action };
          action.status = nextStatus;
          if (extras?.errorMessage) action.errorMessage = extras.errorMessage;
          if (extras?.executionMetadata) action.executionMetadata = extras.executionMetadata;
          action.updatedAt = new Date();
          return { transitioned: true, action };
        },
      ),
    };

    mockCaseRepo = {
      getCaseById: vi.fn(async (_mId: string, cId: string) => {
        const c = inMemoryCases.get(cId);
        if (!c) return null;
        return {
          ...c,
          customer: inMemoryCustomers.get(c.customerId),
          actions: Array.from(inMemoryActions.values()).filter((a) => a.caseId === cId),
        };
      }),
      compareAndSetStatus: vi.fn(
        async (_mId: string, cId: string, expected: CaseStatus, next: CaseStatus) => {
          const c = inMemoryCases.get(cId);
          if (!c || c.status !== expected) {
            throw new Error('Case state conflict');
          }
          c.status = next;
          return c;
        },
      ),
    };

    mockCustomerRepo = {
      updateLastContactedAt: vi.fn(async (_mId: string, custId: string, date: Date) => {
        const cust = inMemoryCustomers.get(custId);
        if (cust) cust.lastContactedAt = date;
      }),
    };

    mockPolicyConfigRepo = {
      getOrCreateConfig: vi.fn(async (_mId: string) => ({
        merchantId: _mId,
        maxRetriesPerCase: 3,
        maxContactsPerCase: 3,
        maxActionsPerCase: 5,
        cooldownHoursBetweenActions: 24,
        highValueThreshold: { toString: () => '50000.00' },
        minConfidenceThreshold: 0.65,
        reviewFirstMode: false,
        checkoutAbandonmentThresholdMinutes: 30,
        quietHoursStart: 21,
        quietHoursEnd: 9,
        quietHoursTimezone: 'Asia/Kolkata',
        maxRecoveryWindowDays: 30,
        overdueGracePeriodDays: 3,
      })),
    };

    mockAuditRepo = {
      record: vi.fn(async (_mId: string, entry: any) => {
        inMemoryAudits.push({ merchantId: _mId, ...entry, createdAt: new Date() });
      }),
    };

    mockMerchantRepo = {
      getMerchantById: vi.fn(async (_mId: string) => ({
        id: _mId,
        name: 'Test Merchant',
        killSwitchActive: false,
      })),
    };

    mockCommitmentRepo = {
      createCommitment: vi.fn(async (_mId: string, cId: string, params: any) => {
        const commitment = {
          id: `cmt_${Date.now()}`,
          caseId: cId,
          promisedAmount: params.promisedAmount,
          promisedDate: params.promisedDate,
          status: params.status || 'PENDING',
          extractedFromText: params.extractedFromText || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        inMemoryCommitments.push(commitment);
        return commitment;
      }),
    };

    mockJobScheduler = {
      schedule: vi.fn(async () => ({
        id: `job_${Date.now()}`,
        status: 'SCHEDULED',
      })),
    };

    policyEngine = new PolicyEngine();
    simulatedProvider = new SimulatedRecoveryProvider();
    providerRegistry = new ProviderRegistry([simulatedProvider]);

    actionExecutor = new ActionExecutor({
      actionRepo: mockActionRepo,
      caseRepo: mockCaseRepo,
      customerRepo: mockCustomerRepo,
      policyConfigRepo: mockPolicyConfigRepo,
      auditRepo: mockAuditRepo,
      merchantRepo: mockMerchantRepo,
      commitmentRepo: mockCommitmentRepo,
      jobScheduler: mockJobScheduler,
      policyEngine,
      providerRegistry,
      clock: () => new Date('2026-08-28T14:00:00+05:30'), // 2:00 PM IST (daytime, outside quiet hours)
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('1. Deterministic Idempotency Key', () => {
    it('generates deterministic idempotency key without random or timestamp noise', () => {
      const key1 = generateActionIdempotencyKey(merchantId, caseId, RecoveryActionType.REQUEST_PAYMENT_UPDATE, 'v1');
      const key2 = generateActionIdempotencyKey(merchantId, caseId, RecoveryActionType.REQUEST_PAYMENT_UPDATE, 'v1');
      const key3 = generateActionIdempotencyKey(merchantId, caseId, RecoveryActionType.REQUEST_PAYMENT_UPDATE, 'v2');

      expect(key1).toBe(`rec_act:${merchantId}:${caseId}:REQUEST_PAYMENT_UPDATE:v1`);
      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('2. Authorization — PolicyEvaluationResult binding & idempotency', () => {
    it('creates authoritative RecoveryAction in PENDING when policyEvaluation.decision is ALLOW', async () => {
      const result = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: { channel: 'WHATSAPP' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      expect(result.authorized).toBe(true);
      expect(result.action).not.toBeNull();
      expect(result.action?.status).toBe(ActionExecutionStatus.PENDING);
      expect(result.action?.policyDecision).toBe(PolicyDecision.ALLOW);

      const auditTypes = inMemoryAudits.map((a) => a.eventType);
      expect(auditTypes).toContain('ACTION_AUTHORIZED');
    });

    it('blocks creation and records ACTION_BLOCKED_BY_POLICY when decision is DENY', async () => {
      const result = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.RETRY_PAYMENT,
        actionParams: {},
        policyEvaluation: denyResult('HARD_CARD_DECLINE', 'Hard decline: card stolen or lost'),
        attemptOrVersion: 'v1',
      });

      expect(result.authorized).toBe(false);
      expect(result.action).toBeNull();
      expect(result.reason).toContain('Hard decline');
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_BLOCKED_BY_POLICY')).toBe(true);
    });

    it('blocks creation and records ACTION_BLOCKED_BY_POLICY when decision is REVIEW', async () => {
      const result = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        actionParams: {},
        policyEvaluation: reviewResult('HIGH_VALUE_THRESHOLD', 'High value threshold exceeded'),
        attemptOrVersion: 'v1',
      });

      expect(result.authorized).toBe(false);
      expect(result.action).toBeNull();
      expect(result.reason).toContain('High value threshold exceeded');
    });

    it('idempotent: same idempotency key twice returns existing action without duplicate ACTION_AUTHORIZED', async () => {
      const params = {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: { channel: 'SMS' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      };

      const first = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, params);
      const second = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, params);

      expect(first.authorized).toBe(true);
      expect(second.authorized).toBe(true);
      // Same action returned
      expect(first.action?.id).toBe(second.action?.id);

      // Exactly ONE ACTION_AUTHORIZED audit — no duplicate
      const authorizedAudits = inMemoryAudits.filter((a) => a.eventType === 'ACTION_AUTHORIZED');
      expect(authorizedAudits.length).toBe(1);

      // Only one action in storage
      expect(inMemoryActions.size).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('3. Kill Switch — Fails Closed', () => {
    it('fails closed when merchant is not found (merchantRepo returns null)', async () => {
      mockMerchantRepo.getMerchantById.mockResolvedValueOnce(null);

      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      // Must NOT execute, must NOT call provider, action must FAIL (not open)
      expect(execResult.success).toBe(false);
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);

      // Action status must be FAILED, not EXECUTING
      const storedAction = inMemoryActions.get(action!.id);
      expect(storedAction?.status).toBe(ActionExecutionStatus.FAILED);

      // ACTION_FAILED audit emitted
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_FAILED')).toBe(true);
    });

    it('fails closed when merchantRepo.getMerchantById throws', async () => {
      mockMerchantRepo.getMerchantById.mockRejectedValueOnce(new Error('DB timeout fetching merchant'));

      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.success).toBe(false);
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_FAILED')).toBe(true);

      const storedAction = inMemoryActions.get(action!.id);
      expect(storedAction?.status).toBe(ActionExecutionStatus.FAILED);
    });

    it('blocks execution when kill switch is enabled after authorization', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: { channel: 'WHATSAPP' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      // Enable kill switch between authorization and execution
      mockMerchantRepo.getMerchantById.mockResolvedValueOnce({
        id: merchantId,
        killSwitchActive: true,
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(false);
      expect(execResult.blockedByPolicy).toBe(true);
      expect(execResult.policyDecision).toBe(PolicyDecision.DENY);
      expect(execResult.policyReasonCode).toBe('KILL_SWITCH_ACTIVE');
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);

      // Action must be CANCELLED, not EXECUTING (claim owner rolled back via CAS)
      const storedAction = inMemoryActions.get(action!.id);
      expect(storedAction?.status).toBe(ActionExecutionStatus.CANCELLED);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('4. Claim-Before-Revalidation Ordering', () => {
    it('only the claim owner revalidates: losing worker returns alreadyClaimed without revalidating', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      let claimCallCount = 0;
      const originalClaim = mockActionRepo.claimActionForExecution;
      mockActionRepo.claimActionForExecution = vi.fn(async (mId: string, aId: string) => {
        claimCallCount++;
        if (claimCallCount === 1) {
          // First worker wins claim
          const result = await originalClaim(mId, aId);
          return result;
        }
        // Subsequent workers observe EXECUTING — return alreadyClaimed
        const storedAction = inMemoryActions.get(aId);
        return { claimed: false, action: storedAction };
      });

      // Two concurrent workers
      const [result1, result2] = await Promise.all([
        actionExecutor.executeAction(merchantId, action!.id),
        actionExecutor.executeAction(merchantId, action!.id),
      ]);

      // Exactly one winner
      const winners = [result1, result2].filter((r) => r.executed && r.success);
      const losers = [result1, result2].filter((r) => !r.executed && r.alreadyClaimed);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);

      // Provider called exactly ONCE
      expect(simulatedProvider.dispatchedCalls.length).toBe(1);

      // Only claim owner emitted ACTION_POLICY_REVALIDATED
      const revalidatedAudits = inMemoryAudits.filter(
        (a) => a.eventType === 'ACTION_POLICY_REVALIDATED',
      );
      expect(revalidatedAudits.length).toBe(1);
    });

    it('loser cannot overwrite EXECUTING or SUCCESS action state via transitionActionStatus', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      // Execute (winner claims + completes)
      await actionExecutor.executeAction(merchantId, action!.id);
      expect(inMemoryActions.get(action!.id)?.status).toBe(ActionExecutionStatus.SUCCESS);

      // Loser tries to transition SUCCESS → CANCELLED via CAS — must fail (count=0)
      const loserResult = await mockActionRepo.transitionActionStatus(
        merchantId,
        action!.id,
        ActionExecutionStatus.EXECUTING, // expected: EXECUTING — but it's now SUCCESS
        ActionExecutionStatus.CANCELLED,
      );
      expect(loserResult.transitioned).toBe(false);

      // Final state must still be SUCCESS — stale worker cannot overwrite
      expect(inMemoryActions.get(action!.id)?.status).toBe(ActionExecutionStatus.SUCCESS);
    });

    it('DENY after claim: action transitions EXECUTING → CANCELLED via CAS, provider NOT called', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      // Customer opts out between authorization and execution
      const customer = inMemoryCustomers.get(customerId);
      customer.optedOut = true;

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(false);
      expect(execResult.blockedByPolicy).toBe(true);
      expect(execResult.policyDecision).toBe(PolicyDecision.DENY);

      // CAS rollback used — transitionActionStatus was called with EXECUTING → CANCELLED
      expect(mockActionRepo.transitionActionStatus).toHaveBeenCalledWith(
        merchantId,
        action!.id,
        ActionExecutionStatus.EXECUTING,
        ActionExecutionStatus.CANCELLED,
        expect.objectContaining({ errorMessage: expect.any(String) }),
      );

      // Action must be CANCELLED, not left EXECUTING
      expect(inMemoryActions.get(action!.id)?.status).toBe(ActionExecutionStatus.CANCELLED);
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('5. ACTION_DISPATCHED Audit Semantics', () => {
    it('emits exactly one ACTION_DISPATCHED immediately before provider.execute() on successful dispatch', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: { channel: 'WHATSAPP' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      await actionExecutor.executeAction(merchantId, action!.id);

      const dispatchedAudits = inMemoryAudits.filter((a) => a.eventType === 'ACTION_DISPATCHED');
      expect(dispatchedAudits.length).toBe(1);
      expect(dispatchedAudits[0].inputSummaryJson.providerName).toBe('SIMULATED_RECOVERY_PROVIDER');
    });

    it('emits zero ACTION_DISPATCHED when no provider is registered for action type', async () => {
      // Use BaseProviderRegistry (from @recoverai/core) with no providers.
      // The integrations ProviderRegistry falls back to SimulatedRecoveryProvider when
      // constructed with an empty array, which would defeat this test.
      const emptyRegistry = new BaseProviderRegistry([]);

      const executorNoProvider = new ActionExecutor({
        actionRepo: mockActionRepo,
        caseRepo: mockCaseRepo,
        customerRepo: mockCustomerRepo,
        policyConfigRepo: mockPolicyConfigRepo,
        auditRepo: mockAuditRepo,
        merchantRepo: mockMerchantRepo,
        policyEngine,
        providerRegistry: emptyRegistry,
        clock: () => new Date('2026-08-28T14:00:00+05:30'),
      });

      const { action } = await executorNoProvider.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await executorNoProvider.executeAction(merchantId, action!.id);

      expect(execResult.success).toBe(false);
      expect(execResult.error).toContain('No provider registered');

      // Zero ACTION_DISPATCHED audits
      const dispatchedAudits = inMemoryAudits.filter((a) => a.eventType === 'ACTION_DISPATCHED');
      expect(dispatchedAudits.length).toBe(0);

      // ACTION_FAILED was emitted
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_FAILED')).toBe(true);
    });

    it('emits zero ACTION_DISPATCHED for internal STOP_RECOVERY action', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.STOP_RECOVERY,
        actionParams: { reason: 'Test stop' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      await actionExecutor.executeAction(merchantId, action!.id);

      const dispatchedAudits = inMemoryAudits.filter((a) => a.eventType === 'ACTION_DISPATCHED');
      expect(dispatchedAudits.length).toBe(0);

      // ACTION_SUCCEEDED was emitted
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_SUCCEEDED')).toBe(true);
    });

    it('emits zero ACTION_DISPATCHED for internal RECORD_PROMISE_TO_PAY action', async () => {
      const receivableCaseId = 'case_receivable_dispatch_test';
      inMemoryCases.set(receivableCaseId, {
        id: receivableCaseId,
        merchantId,
        customerId,
        riskType: RiskType.OVERDUE_RECEIVABLE,
        amountAtRisk: { toString: () => '5000.00' },
        currency: 'INR',
        status: CaseStatus.OPEN,
        openedAt: new Date(Date.now() - 3600000),
        contextJson: {},
        customer: inMemoryCustomers.get(customerId),
        actions: [],
        outcomes: [],
      });

      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, receivableCaseId, {
        actionType: RecoveryActionType.RECORD_PROMISE_TO_PAY,
        actionParams: { promisedAmount: '1500.00', promisedDate: '2026-09-01T00:00:00.000Z' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      await actionExecutor.executeAction(merchantId, action!.id);

      const dispatchedAudits = inMemoryAudits.filter((a) => a.eventType === 'ACTION_DISPATCHED');
      expect(dispatchedAudits.length).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('6. Internal Action Safe Failure', () => {
    it('SCHEDULE_FOLLOWUP: fails safely when jobScheduler is absent', async () => {
      // Executor without jobScheduler
      const executorNoScheduler = new ActionExecutor({
        actionRepo: mockActionRepo,
        caseRepo: mockCaseRepo,
        customerRepo: mockCustomerRepo,
        policyConfigRepo: mockPolicyConfigRepo,
        auditRepo: mockAuditRepo,
        merchantRepo: mockMerchantRepo,
        commitmentRepo: mockCommitmentRepo,
        policyEngine,
        providerRegistry,
        clock: () => new Date('2026-08-28T14:00:00+05:30'),
        // jobScheduler intentionally omitted
      });

      const { action } = await executorNoScheduler.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.SCHEDULE_FOLLOWUP,
        actionParams: { scheduledFor: '2026-08-30T10:00:00.000Z' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await executorNoScheduler.executeAction(merchantId, action!.id);

      expect(execResult.success).toBe(false);
      expect(execResult.error).toContain('jobScheduler');

      // Action must be FAILED, not EXECUTING or SUCCESS
      expect(inMemoryActions.get(action!.id)?.status).toBe(ActionExecutionStatus.FAILED);

      // ACTION_FAILED audit emitted
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_FAILED')).toBe(true);

      // ACTION_SUCCEEDED must NOT have been emitted
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_SUCCEEDED')).toBe(false);
    });

    it('SCHEDULE_FOLLOWUP: fails safely when scheduler.schedule throws', async () => {
      mockJobScheduler.schedule.mockRejectedValueOnce(new Error('pg-boss connection lost'));

      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.SCHEDULE_FOLLOWUP,
        actionParams: { scheduledFor: '2026-08-30T10:00:00.000Z' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.success).toBe(false);
      expect(execResult.error).toContain('pg-boss');

      expect(inMemoryActions.get(action!.id)?.status).toBe(ActionExecutionStatus.FAILED);
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_FAILED')).toBe(true);
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_SUCCEEDED')).toBe(false);
    });

    it('STOP_RECOVERY: fails safely when compareAndSetStatus throws (case state conflict)', async () => {
      // Case will throw on CAS — simulates concurrent state change
      mockCaseRepo.compareAndSetStatus.mockRejectedValueOnce(
        new Error('Case state conflict: expected OPEN but got RECOVERED'),
      );

      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.STOP_RECOVERY,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.success).toBe(false);

      // Action must be FAILED, not left EXECUTING
      expect(inMemoryActions.get(action!.id)?.status).toBe(ActionExecutionStatus.FAILED);
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_FAILED')).toBe(true);

      // ACTION_SUCCEEDED must NOT have been emitted
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_SUCCEEDED')).toBe(false);
    });

    it('RECORD_PROMISE_TO_PAY: fails safely when commitmentRepo is absent', async () => {
      const receivableCaseId = 'case_receivable_commit_test';
      inMemoryCases.set(receivableCaseId, {
        id: receivableCaseId,
        merchantId,
        customerId,
        riskType: RiskType.OVERDUE_RECEIVABLE,
        amountAtRisk: { toString: () => '5000.00' },
        currency: 'INR',
        status: CaseStatus.OPEN,
        openedAt: new Date(Date.now() - 3600000),
        contextJson: {},
        customer: inMemoryCustomers.get(customerId),
        actions: [],
        outcomes: [],
      });

      // Executor without commitmentRepo
      const executorNoCommit = new ActionExecutor({
        actionRepo: mockActionRepo,
        caseRepo: mockCaseRepo,
        customerRepo: mockCustomerRepo,
        policyConfigRepo: mockPolicyConfigRepo,
        auditRepo: mockAuditRepo,
        merchantRepo: mockMerchantRepo,
        jobScheduler: mockJobScheduler,
        policyEngine,
        providerRegistry,
        clock: () => new Date('2026-08-28T14:00:00+05:30'),
        // commitmentRepo intentionally omitted
      });

      const { action } = await executorNoCommit.authorizeAndCreateAction(
        merchantId,
        receivableCaseId,
        {
          actionType: RecoveryActionType.RECORD_PROMISE_TO_PAY,
          actionParams: { promisedAmount: '1500.00', promisedDate: '2026-09-01T00:00:00.000Z' },
          policyEvaluation: allowResult(),
          attemptOrVersion: 'v1',
        },
      );

      const execResult = await executorNoCommit.executeAction(merchantId, action!.id);

      expect(execResult.success).toBe(false);
      expect(execResult.error).toContain('commitmentRepo');

      expect(inMemoryActions.get(action!.id)?.status).toBe(ActionExecutionStatus.FAILED);
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_FAILED')).toBe(true);
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_SUCCEEDED')).toBe(false);
    });

    it('RECORD_PROMISE_TO_PAY: creates authoritative RecoveryCommitment, not just metadata', async () => {
      const receivableCaseId = 'case_receivable_ptp_test';
      inMemoryCases.set(receivableCaseId, {
        id: receivableCaseId,
        merchantId,
        customerId,
        riskType: RiskType.OVERDUE_RECEIVABLE,
        amountAtRisk: { toString: () => '5000.00' },
        currency: 'INR',
        status: CaseStatus.OPEN,
        openedAt: new Date(Date.now() - 3600000),
        contextJson: {},
        customer: inMemoryCustomers.get(customerId),
        actions: [],
        outcomes: [],
      });

      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, receivableCaseId, {
        actionType: RecoveryActionType.RECORD_PROMISE_TO_PAY,
        actionParams: { promisedAmount: '1500.00', promisedDate: '2026-09-01T00:00:00.000Z' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.success).toBe(true);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.SUCCESS);

      // commitmentRepo.createCommitment was called — authoritative record persisted
      expect(mockCommitmentRepo.createCommitment).toHaveBeenCalledWith(
        merchantId,
        receivableCaseId,
        expect.objectContaining({
          promisedAmount: '1500.00',
          promisedDate: expect.any(Date),
        }),
      );

      // Exactly one commitment in storage
      expect(inMemoryCommitments.length).toBe(1);
      expect(inMemoryCommitments[0].promisedAmount).toBe('1500.00');

      // executionMetadata references the commitmentId
      const storedAction = inMemoryActions.get(action!.id);
      expect(storedAction?.executionMetadata?.commitmentId).toBeDefined();

      // No ACTION_DISPATCHED
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_DISPATCHED')).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('7. Fresh Policy Revalidation (existing tests updated)', () => {
    it('executes successfully when fresh policy revalidation confirms ALLOW', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: { channel: 'WHATSAPP' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(true);
      expect(execResult.success).toBe(true);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.SUCCESS);
      expect(execResult.result?.providerName).toBe('SIMULATED_RECOVERY_PROVIDER');
      expect(execResult.result?.isSimulated).toBe(true);

      const auditTypes = inMemoryAudits.map((a) => a.eventType);
      expect(auditTypes).toContain('ACTION_AUTHORIZED');
      expect(auditTypes).toContain('ACTION_CLAIMED');
      expect(auditTypes).toContain('ACTION_POLICY_REVALIDATED');
      expect(auditTypes).toContain('ACTION_DISPATCHED');
      expect(auditTypes).toContain('ACTION_SUCCEEDED');
    });

    it('blocks execution when case is already in terminal state', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: { channel: 'WHATSAPP' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const c = inMemoryCases.get(caseId);
      c.status = CaseStatus.RECOVERED;

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(false);
      expect(execResult.blockedByPolicy).toBe(true);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.CANCELLED);
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('8. Atomic Claiming & Non-Duplicate Dispatch', () => {
    it('returns alreadyClaimed without dispatching when action is not PENDING', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const firstResult = await actionExecutor.executeAction(merchantId, action!.id);
      expect(firstResult.executed).toBe(true);
      expect(firstResult.success).toBe(true);

      const secondResult = await actionExecutor.executeAction(merchantId, action!.id);
      expect(secondResult.executed).toBe(false);
      expect(secondResult.alreadyClaimed).toBe(true);
      expect(simulatedProvider.dispatchedCalls.length).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('9. Provider Failure Semantics', () => {
    it('persists FAILED status and records retryable failure classification', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      simulatedProvider.setBehavior({
        forceOutcome: ProviderExecutionOutcome.RETRYABLE_FAILURE,
        forceErrorClassification: 'NETWORK_TIMEOUT',
        forceErrorMessage: 'Gateway timed out',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(true);
      expect(execResult.success).toBe(false);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.FAILED);
      expect(execResult.result?.errorClassification).toBe('NETWORK_TIMEOUT');
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_FAILED' && a.reasonCode === 'NETWORK_TIMEOUT')).toBe(true);
    });

    it('persists FAILED and records permanent failure classification', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      simulatedProvider.setBehavior({
        forceOutcome: ProviderExecutionOutcome.PERMANENT_FAILURE,
        forceErrorClassification: 'INVALID_REQUEST',
        forceErrorMessage: 'Invalid phone number',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.success).toBe(false);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.FAILED);
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_FAILED' && a.reasonCode === 'INVALID_REQUEST')).toBe(true);
    });

    it('does not swallow unhandled provider exceptions; throws ActionExecutionError', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      simulatedProvider.setBehavior({
        throwException: new Error('Unexpected socket reset'),
      });

      await expect(actionExecutor.executeAction(merchantId, action!.id)).rejects.toThrow(ActionExecutionError);
      expect(inMemoryAudits.some((a) => a.reasonCode === 'UNHANDLED_PROVIDER_EXCEPTION')).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('10. Internal Actions — Happy Path', () => {
    it('STOP_RECOVERY: transitions case to STOPPED, emits ACTION_SUCCEEDED, no provider called', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.STOP_RECOVERY,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.success).toBe(true);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.STOPPED);
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_SUCCEEDED')).toBe(true);
    });

    it('SCHEDULE_FOLLOWUP: dispatches to scheduler and emits ACTION_SUCCEEDED', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.SCHEDULE_FOLLOWUP,
        actionParams: { scheduledFor: '2026-08-30T10:00:00.000Z' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.success).toBe(true);
      expect(mockJobScheduler.schedule).toHaveBeenCalledOnce();
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
    });

    it('blocks RECORD_PROMISE_TO_PAY on PAYMENT_FAILURE due to action compatibility matrix', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.RECORD_PROMISE_TO_PAY,
        actionParams: { promisedAmount: '1500.00', promisedDate: '2026-09-01T00:00:00.000Z' },
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(false);
      expect(execResult.blockedByPolicy).toBe(true);
      expect(execResult.policyDecision).toBe(PolicyDecision.DENY);
      expect(execResult.policyReasonCode).toBe('INCOMPATIBLE_ACTION_FOR_RISK');
    });

    it('blocks ESCALATE_TO_HUMAN from automated dispatch due to policy REVIEW decision', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.ESCALATE_TO_HUMAN,
        actionParams: {},
        policyEvaluation: allowResult(),
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(false);
      expect(execResult.blockedByPolicy).toBe(true);
      expect(execResult.policyDecision).toBe(PolicyDecision.REVIEW);
      expect(execResult.policyReasonCode).toBe('AGENT_REQUESTED_REVIEW');
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
    });
  });

  it('routes explicitly configured Test Mode payment-link execution through ActionExecutor to Razorpay, not the simulator', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'plink_runtime', status: 'created' }), { status: 200 }));
    const runtimeRegistry = ProviderRegistry.forRuntime({ enabled: true, keyId: 'rzp_test_key', keySecret: 'secret', boundMerchantId: merchantId, fetchImpl });
    const executor = new ActionExecutor({
      actionRepo: mockActionRepo, caseRepo: mockCaseRepo, customerRepo: mockCustomerRepo,
      policyConfigRepo: mockPolicyConfigRepo, auditRepo: mockAuditRepo, merchantRepo: mockMerchantRepo,
      commitmentRepo: mockCommitmentRepo, jobScheduler: mockJobScheduler, policyEngine, providerRegistry: runtimeRegistry,
      clock: () => new Date('2026-08-28T14:00:00+05:30'),
    });
    const { action } = await executor.authorizeAndCreateAction(merchantId, caseId, {
      actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, actionParams: {}, policyEvaluation: allowResult(), attemptOrVersion: 'runtime',
    });
    const result = await executor.executeAction(merchantId, action!.id);
    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(simulatedProvider.dispatchedCalls).toHaveLength(0);
    expect(inMemoryActions.get(action!.id).externalActionId).toBe('plink_runtime');
  });
});
